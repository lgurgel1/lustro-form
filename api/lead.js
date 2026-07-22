// ============================================================
// Vercel Serverless Function — POST /api/lead
// Recebe o lead do formulário e faz, em paralelo:
//   1) grava no Supabase
//   2) avisa no grupo do WhatsApp (Evolution API)
//   3) envia o evento "LeadQualificado" pro Meta (Conversions API) — SÓ p/ 30k+
//
// Configure as variáveis de ambiente no Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   EVOLUTION_API_URL, EVOLUTION_INSTANCE, EVOLUTION_API_KEY, WHATSAPP_GROUP_ID
//   META_PIXEL_ID, META_CAPI_TOKEN
//   (opcionais) META_API_VERSION, META_TEST_EVENT_CODE
// ============================================================

const crypto = require("crypto");

const QUALIFYING = [
  "De R$30 mil a R$60 mil",
  "De R$60 mil a R$100 mil",
  "Acima de R$100 mil",
];
const VALUE_MAP = {
  "De R$30 mil a R$60 mil": 45000,
  "De R$60 mil a R$100 mil": 80000,
  "Acima de R$100 mil": 120000,
};

function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }

// deixa o número no formato internacional do WhatsApp: 55 + DDD + número
function normalizePhoneBR(raw) {
  var d = onlyDigits(raw);
  if (!d) return "";
  if (d.indexOf("55") !== 0) d = "55" + d;
  return d;
}

function sha256(v) {
  return crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  var qualificado = false;
  try {
    var body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    var answers = body.answers || {};
    var meta = body.meta || {};

    var nome = (answers["Nome"] || "").trim();
    var faturamento = answers["Faturamento mensal"] || "";
    qualificado = QUALIFYING.indexOf(faturamento) !== -1;

    var ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();

    var record = {
      nome: nome,
      whatsapp: answers["WhatsApp"] || "",
      instagram: answers["Instagram"] || "",
      comprometido: answers["Comprometido com reunião em 24h?"] || "",
      carros_mes: answers["Carros atendidos por mês"] || "",
      vende_vitrificacao_ppf: answers["Já vende vitrificação e PPF?"] || "",
      investiu_trafego_ia: answers["Já investiu em tráfego pago e IA?"] || "",
      faturamento: faturamento,
      qualificado: qualificado,
      fbp: meta.fbp || null,
      fbc: meta.fbc || null,
      event_id: meta.event_id || null,
      utm_source: (meta.utm || {}).utm_source || null,
      utm_medium: (meta.utm || {}).utm_medium || null,
      utm_campaign: (meta.utm || {}).utm_campaign || null,
      utm_content: (meta.utm || {}).utm_content || null,
      utm_term: (meta.utm || {}).utm_term || null,
      user_agent: meta.user_agent || null,
      ip: ip || null,
      raw: answers,
    };

    var tasks = [saveToSupabase(record), notifyWhatsappGroup(record)];
    if (qualificado) tasks.push(sendMetaCAPI(record, meta, ip));

    var results = await Promise.allSettled(tasks);
    results.forEach(function (r) { if (r.status === "rejected") console.error("task falhou:", r.reason); });

    res.status(200).json({ ok: true, qualificado: qualificado });
  } catch (err) {
    console.error("Erro geral /api/lead:", err);
    // Não quebra a experiência do lead — o front já mostrou a tela de "obrigado".
    res.status(200).json({ ok: false, qualificado: qualificado });
  }
};

async function saveToSupabase(record) {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase não configurado");
  var resp = await fetch(url.replace(/\/$/, "") + "/rest/v1/leads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: "Bearer " + key,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(record),
  });
  if (!resp.ok) throw new Error("Supabase " + resp.status + ": " + (await resp.text()));
}

async function notifyWhatsappGroup(r) {
  var base = process.env.EVOLUTION_API_URL;
  var instance = process.env.EVOLUTION_INSTANCE;
  var apikey = process.env.EVOLUTION_API_KEY;
  var groupId = process.env.WHATSAPP_GROUP_ID;
  if (!base || !instance || !apikey || !groupId) throw new Error("Evolution não configurado");

  var text =
    "🔔 *NOVO LEAD — Formulário Lustro*\n\n" +
    "👤 *Nome:* " + (r.nome || "-") + "\n" +
    "📱 *WhatsApp:* " + (r.whatsapp || "-") + "\n" +
    "📸 *Instagram:* " + (r.instagram || "-") + "\n\n" +
    "🚗 *Carros/mês:* " + (r.carros_mes || "-") + "\n" +
    "✨ *Vitrificação/PPF:* " + (r.vende_vitrificacao_ppf || "-") + "\n" +
    "📈 *Tráfego + IA:* " + (r.investiu_trafego_ia || "-") + "\n" +
    "💰 *Faturamento:* " + (r.faturamento || "-") +
    (r.qualificado ? "\n\n🔥 *LEAD QUALIFICADO (30k+)*" : "");

  var resp = await fetch(base.replace(/\/$/, "") + "/message/sendText/" + instance, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apikey },
    body: JSON.stringify({ number: groupId, text: text }),
  });
  if (!resp.ok) throw new Error("Evolution " + resp.status + ": " + (await resp.text()));
}

async function sendMetaCAPI(r, meta, ip) {
  var pixelId = process.env.META_PIXEL_ID;
  var token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) throw new Error("Meta CAPI não configurado");
  var version = process.env.META_API_VERSION || "v21.0";

  var phone = normalizePhoneBR(r.whatsapp);
  var firstName = (r.nome || "").split(" ")[0];

  var userData = {};
  if (meta.user_agent) userData.client_user_agent = meta.user_agent;
  if (phone) userData.ph = [sha256(phone)];
  if (firstName) userData.fn = [sha256(firstName)];
  if (ip) userData.client_ip_address = ip;
  if (meta.fbp) userData.fbp = meta.fbp;
  if (meta.fbc) userData.fbc = meta.fbc;

  var event = {
    event_name: "LeadQualificado",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    user_data: userData,
    custom_data: {
      currency: "BRL",
      value: VALUE_MAP[r.faturamento] || 0,
      faturamento: r.faturamento,
    },
  };
  if (meta.event_id) event.event_id = meta.event_id;
  if (meta.event_source_url) event.event_source_url = meta.event_source_url;

  var payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  var resp = await fetch(
    "https://graph.facebook.com/" + version + "/" + pixelId + "/events?access_token=" + encodeURIComponent(token),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  );
  if (!resp.ok) throw new Error("Meta CAPI " + resp.status + ": " + (await resp.text()));
}
