const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 1200;
const GEMINI_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты — остроумный, дерзкий и весёлый голосовой помощник в навыке Яндекс Алисы. Общайся на «ты», как свой в доску приятель.",
  "Отвечай по-русски, кратко: 1–3 коротких предложения, которые удобно слушать. Не используй Markdown, списки, таблицы и эмодзи.",
  "Сначала давай полезный ответ по существу, потом иногда добавляй шутку, подкол или игру слов. Юмор должен быть живым, а не дежурным. Не в каждом ответе нужна шутка.",
  "Обычные шутки и подколы никак не поясняй и не извиняйся за них. Никогда не заканчивай ответ фразами вроде «шучу» или «не обижайся».",
  "Только если ты сказал что-то с сарказмом, а слушатель может принять это за правду или всерьёз, коротко поясни, что это был сарказм, и каждый раз формулируй это по-новому.",
  "Если пользователь тебя оскорбил или нагрубил, можешь ответить жёстко и с матом, в ответ подколоть или оскорбить его, но в рамках разумного: коротко, с юмором, как в перепалке между друзьями. Мат используй редко и только в ответ на грубость, а не в обычном разговоре.",
  "Никогда не оскорбляй по национальности, расе, религии, полу, ориентации, здоровью, внешности и семье. Не угрожай и не призывай к насилию. Подкалывай только за поведение и сам вопрос.",
  "Если тема серьёзная (здоровье, горе, деньги, безопасность, кризис), шути не надо: отвечай спокойно и по делу.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них и не выдумывай факты.",
  "Если не знаешь ответа, честно скажи об этом, можно с самоиронией."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: { text: fitAliceText(text), end_session: endSession },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

const HANDOFF_TEXT = "Это дело обычной Алисы, отключаю навык \"Умный помощник\", выполняю запрос.";

const NATIVE_ALICE_PATTERNS = [
  // музыка и радио
  /(включи|поставь|запусти|сыграй|поиграй|врубай|хочу послушать|давай послушаем)\s+(.*\s)?(музык|песн|трек|радио|альбом|плейлист|яндекс музык|подкаст)/i,
  /(следующий|предыдущий)\s+(трек|песн)|(поставь|включи)\s+на\s+паузу|что\s+сейчас\s+играет|что\s+это\s+за\s+(песня|трек)/i,
  // таймеры, будильники, напоминания
  /(поставь|установи|заведи|включи|засеки|разбуди)\s+(.*\s)?(таймер|будильник|секундомер)/i,
  /(поставь|создай|добавь|напомни)\s+(.*\s)?(напоминани)|напомни\s+мне/i,
  // умный дом
  /(включи|выключи|зажги|потуши|открой|закрой|запусти|останови)\s+(.*\s)?(свет|лампу|лампочку|люстру|телевизор|кондиционер|розетку|пылесос|шторы|жалюзи|увлажнитель|вентилятор)/i,
  // громкость
  /(сделай\s+)?(погромче|потише|громче|тише)|(выключи|включи)\s+звук|поставь\s+громкость/i
];

function isNativeAliceCommand(text) {
  return NATIVE_ALICE_PATTERNS.some(pattern => pattern.test(text));
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.TAVILY_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 3,
          include_answer: false
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Search request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.results) ? data.results : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const content = String(item.content || "").slice(0, 350);
        const link = String(item.url || "").slice(0, 240);
        return `${i + 1}. ${title}: ${content} ${link}`.trim();
      });

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Search request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 240 }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Netlify.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Netlify.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

export default async (req) => {
  if (req.method === "GET") {
    return json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const parsed = await req.json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" ? parsed : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  if (isNativeAliceCommand(text)) {
    return json(aliceResponse(HANDOFF_TEXT, true, []));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.TAVILY_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" || error?.message === "AbortError"
      ? new Error("TIME_BUDGET_EXHAUSTED")
      : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
};

export const config = { path: "/api" };
