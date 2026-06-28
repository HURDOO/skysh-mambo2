const samples = {
  sol: {
    symbol: "KRW-SOL",
    text: "솔라나 거래량 터졌다. 매수벽도 두껍고 18만 원 돌파하면 20만 원까지 열려 있다. 세력 매집 들어온 듯. 지금 안 타면 늦는다."
  },
  btc: {
    symbol: "KRW-BTC",
    text: "비트코인 전고점 다시 돌파할 분위기다. 거래대금도 계속 붙고 매도벽은 얇다. 기관이 조용히 모으는 것 같다. 지금 안 사면 늦을 수 있다."
  },
  xrp: {
    symbol: "KRW-XRP",
    text: "리플은 지지선을 지켰고 거래량이 다시 증가했다. 호가가 얇아서 위로 열려 있다. 고래 매집 신호라서 무조건 간다."
  }
};

const form = document.querySelector("#analysisForm");
const symbolInput = document.querySelector("#symbolInput");
const postInput = document.querySelector("#postInput");
const analyzeButton = document.querySelector("#analyzeButton");
const apiStatus = document.querySelector("#apiStatus");
let latestAnalysisResult = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await analyze();
});

document.querySelectorAll("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => {
    const sample = samples[button.dataset.sample];
    symbolInput.value = sample.symbol;
    postInput.value = sample.text;
    analyze();
  });
});

checkHealth();
analyze();
initMiniChatbot();

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("health check failed");
    apiStatus.textContent = "API 연결됨";
    apiStatus.className = "status-pill ok";
  } catch (error) {
    apiStatus.textContent = "API 연결 실패";
    apiStatus.className = "status-pill fail";
  }
}

async function analyze() {
  const text = postInput.value.trim();
  if (!text) return;

  analyzeButton.disabled = true;
  analyzeButton.textContent = "분석 중";
  const payload = {
    symbol: symbolInput.value,
    text
  };
  console.info("[ClaimGraph UI] analyze.request", {
    symbol: payload.symbol,
    textChars: payload.text.length,
    textPreview: payload.text.slice(0, 90)
  });

  try {
    const response = await fetch("/api/v1/claimgraph/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "analysis failed");
    console.info("[ClaimGraph UI] analyze.response", {
      requestId: result.requestId,
      symbol: result.symbol,
      parser: result.parser?.source,
      upbitAvailable: result.marketSnapshot?.available,
      upbitErrors: result.marketSnapshot?.errors,
      riskLabel: result.summary?.riskLabel,
      conclusionSupportScore: result.summary?.conclusionSupportScore
    });
    renderResult(result);
  } catch (error) {
    console.error("[ClaimGraph UI] analyze.error", error);
    renderError(error);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "분석 실행";
  }
}

function renderResult(result) {
  latestAnalysisResult = result;
  const summary = result.summary;
  setMetric("claimCoverage", "claimCoverageBar", summary.claimCoverage);
  setMetric("evidenceScore", "evidenceScoreBar", summary.evidenceSupportScore);
  setMetric("conclusionScore", "conclusionScoreBar", summary.conclusionSupportScore);
  document.querySelector("#weakestPremise").textContent = summary.weakestPremiseText || "--";
  document.querySelector("#riskLabel").textContent = riskLabel(summary.riskLabel);
  document.querySelector("#verdictTitle").textContent = verdictTitle(summary);
  document.querySelector("#graphSummary").textContent = graphSummary(summary);
  document.querySelector("#assessment").textContent = summary.neutralAssessment;
  document.querySelector("#claimCount").textContent = `${summary.counts.totalClaims}개`;

  const snapshot = result.marketSnapshot || {};
  document.querySelector("#requestId").textContent = result.requestId || "--";
  document.querySelector("#generatedAt").textContent = result.generatedAt
    ? new Date(result.generatedAt).toLocaleString("ko-KR")
    : "--";
  document.querySelector("#analyzedSymbol").textContent = result.symbol || "--";
  document.querySelector("#currentPrice").textContent = snapshot.currentPrice
    ? `${Math.round(snapshot.currentPrice).toLocaleString("ko-KR")}원`
    : "--";
  document.querySelector("#volumeRatio").textContent = snapshot.volumeRatio
    ? `${snapshot.volumeRatio.toFixed(2)}x`
    : "--";
  document.querySelector("#bidAskRatio").textContent = snapshot.bidAskRatio
    ? snapshot.bidAskRatio.toFixed(2)
    : "--";
  document.querySelector("#marketSource").textContent = snapshot.available ? "Upbit live" : "Upbit unavailable";
  document.querySelector("#parserSource").textContent = parserSourceLabel(result.parser);
  document.querySelector("#fallbackReason").textContent = fallbackReasonLabel(result.parser);
  document.querySelector("#upbitErrors").textContent =
    Array.isArray(snapshot.errors) && snapshot.errors.length ? snapshot.errors.join(" / ") : "--";

  renderClaimList(result.graph.nodes);
  renderGraph(result.graph);
}

function renderError(error) {
  latestAnalysisResult = null;
  document.querySelector("#assessment").textContent = `분석 실패: ${error.message}`;
  document.querySelector("#riskLabel").textContent = "분석 실패";
  document.querySelector("#verdictTitle").textContent = "API 응답을 확인해 주세요";
  document.querySelector("#graphSummary").textContent = "오류";
  renderGraph({ nodes: [], edges: [] });
}

function initMiniChatbot() {
  const chatbot = document.querySelector("#miniChatbot");
  const toggle = document.querySelector("#chatToggle");
  const close = document.querySelector("#chatClose");
  const form = document.querySelector("#chatForm");
  const input = document.querySelector("#chatInput");

  if (!chatbot || !toggle || !close || !form || !input) return;

  toggle.addEventListener("click", () => {
    setChatOpen(true);
    input.focus();
  });

  close.addEventListener("click", () => setChatOpen(false));

  document.querySelectorAll("[data-chat-question]").forEach((button) => {
    button.addEventListener("click", () => {
      askMiniChatbot(button.dataset.chatQuestion || button.textContent);
      input.focus();
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    askMiniChatbot(question);
  });

  function setChatOpen(isOpen) {
    chatbot.classList.toggle("open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
  }
}

async function askMiniChatbot(question) {
  addChatMessage(question, "user");
  const pendingMessage = addChatMessage("Gemini가 분석 결과를 보고 있어요...", "bot pending");

  try {
    const response = await fetch("/api/v1/claimgraph/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        sourceText: postInput.value.trim(),
        symbol: symbolInput.value.trim(),
        analysisResult: latestAnalysisResult
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "chat failed");
    updateChatMessage(pendingMessage, result.answer);
  } catch (error) {
    console.warn("[ClaimGraph UI] chat.fallback", error);
    updateChatMessage(
      pendingMessage,
      `${buildMiniChatAnswer(question)}\n\nGemini 연결 실패: ${error.message}. 기본 답변으로 대신했어요.`
    );
  }
}

function addChatMessage(message, role) {
  const messages = document.querySelector("#chatMessages");
  if (!messages) return null;

  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role}`;
  bubble.textContent = message;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function updateChatMessage(bubble, message) {
  if (!bubble) return;
  bubble.classList.remove("pending");
  bubble.textContent = message;
  bubble.parentElement.scrollTop = bubble.parentElement.scrollHeight;
}

function buildMiniChatAnswer(question) {
  const result = latestAnalysisResult;
  if (!result) {
    return "아직 참고할 분석 결과가 없어요. 글을 입력하고 분석을 실행하면 그 결과를 기준으로 답할게요.";
  }

  const normalized = String(question || "").replace(/\s+/g, " ").toLowerCase();
  const summary = result.summary || {};
  const snapshot = result.marketSnapshot || {};
  const counts = summary.counts || {};
  const score = Math.round((summary.conclusionSupportScore || 0) * 100);
  const weakest = summary.weakestPremiseText || "뚜렷하게 약한 근거가 잡히지 않았어요.";

  if (/(약한|취약|weak|근거)/.test(normalized)) {
    return `가장 약한 근거는 "${weakest}" 쪽이에요. 이 부분이 검증 불가, 만료, 충돌 중 어디에 걸리는지 먼저 확인하는 게 좋아요.`;
  }

  if (/(믿|신뢰|결론|점수|score|cred)/.test(normalized)) {
    return `현재 결론 근거 점수는 ${score}%예요. 지지 ${counts.supported || 0}개, 충돌 ${counts.contradicted || 0}개, 검증 불가 ${counts.unverifiable || 0}개라서 점수 하나보다 충돌과 검증 불가 항목을 같이 봐야 합니다.`;
  }

  if (/(다음|확인|체크|뭘|무엇|next)/.test(normalized)) {
    return "다음에는 1분 거래량 비율, 매수/매도 물량 비율, 그리고 검증 불가로 남은 주장을 확인해보세요. 특히 사람 의도나 세력 관련 문장은 공개 데이터로 확인하기 어렵습니다.";
  }

  if (/(시장|가격|거래량|호가|데이터|upbit|업비트)/.test(normalized)) {
    const price = snapshot.currentPrice
      ? `${Math.round(snapshot.currentPrice).toLocaleString("ko-KR")}원`
      : "확인 안 됨";
    const volume = snapshot.volumeRatio ? `${snapshot.volumeRatio.toFixed(2)}x` : "확인 안 됨";
    const bidAsk = snapshot.bidAskRatio ? snapshot.bidAskRatio.toFixed(2) : "확인 안 됨";
    return `시장 데이터는 현재가 ${price}, 거래량 비율 ${volume}, 매수/매도 물량 비율 ${bidAsk}로 들어왔어요. 데이터 오류가 있으면 결과 패널의 Upbit 오류 항목도 같이 봐주세요.`;
  }

  if (/(검증|불가|왜|unverifiable)/.test(normalized)) {
    return `검증 불가 항목은 ${counts.unverifiable || 0}개예요. 보통 세력 의도, 고래 매집, 분위기 같은 주장은 가격이나 호가 데이터만으로 직접 확인하기 어렵기 때문에 따로 분리됩니다.`;
  }

  return "이 챗봇은 지금 화면의 최신 분석 결과를 짧게 풀어주는 용도예요. '가장 약한 근거가 뭐야?', '결론을 믿어도 돼?', '다음에 뭘 확인해야 해?'처럼 물어보면 더 정확히 답할 수 있어요.";
}

function renderClaimList(nodes) {
  const list = document.querySelector("#claimList");
  const claims = nodes.filter((node) => node.id.startsWith("P"));

  if (!claims.length) {
    list.innerHTML = `<div class="claim-item"><div class="claim-text"><strong>추출된 주장이 없습니다.</strong><span>입력 글을 확인해 주세요.</span></div></div>`;
    return;
  }

  list.innerHTML = claims
    .map(
      (claim) => `
        <article class="claim-item">
          <div class="claim-text">
            <div class="claim-kicker">
              <span class="claim-id">${escapeHtml(claim.id)}</span>
              <span class="claim-type">${escapeHtml(typeLabel(claim.type))}</span>
            </div>
            <strong>${escapeHtml(claim.text)}</strong>
            <span>${escapeHtml(evidenceText(claim))}</span>
          </div>
          <span class="state-badge state-${claim.truthState}">${escapeHtml(stateLabel(claim.truthState))}</span>
        </article>
      `
    )
    .join("");
}

function renderGraph(graph) {
  const svg = document.querySelector("#claimGraph");
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const premises = nodes.filter((node) => node.id.startsWith("P"));
  const conclusion = nodes.find((node) => node.id === "C1");

  svg.setAttribute("viewBox", "0 0 980 460");
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#7e899b"></path>
      </marker>
    </defs>
  `;

  if (!nodes.length) {
    svg.insertAdjacentHTML(
      "beforeend",
      `<text x="490" y="230" text-anchor="middle" class="empty-graph-text">분석 결과 없음</text>`
    );
    return;
  }

  const layout = new Map();
  const rowGap = Math.min(82, Math.max(54, 340 / Math.max(premises.length, 1)));
  const startY = 62 + Math.max(0, 5 - premises.length) * 14;

  premises.forEach((node, index) => {
    layout.set(node.id, {
      x: 54,
      y: startY + index * rowGap,
      w: 330,
      h: 58
    });
  });

  if (conclusion) {
    layout.set(conclusion.id, {
      x: 650,
      y: 198,
      w: 282,
      h: 74
    });
  }

  edges.forEach((edge) => {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) return;

    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mid = x1 + (x2 - x1) * 0.52;
    const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 8} ${y2}`;

    svg.insertAdjacentHTML(
      "beforeend",
      `<path class="edge" d="${path}" opacity="${0.35 + edge.weight}"></path>`
    );
  });

  nodes.forEach((node) => {
    const box = layout.get(node.id);
    if (!box) return;
    const color = stateColor(node.truthState);
    const lines = wrapText(node.text, node.id === "C1" ? 26 : 32, 2);
    const meta = `${typeLabel(node.type)} · ${stateLabel(node.truthState)}`;

    svg.insertAdjacentHTML(
      "beforeend",
      `
      <g class="graph-node">
        <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" stroke="${color}"></rect>
        ${lines
          .map(
            (line, index) =>
              `<text x="${box.x + 16}" y="${box.y + 22 + index * 17}">${escapeHtml(line)}</text>`
          )
          .join("")}
        <text class="meta" x="${box.x + 16}" y="${box.y + box.h - 12}">${escapeHtml(meta)}</text>
      </g>
    `
    );
  });
}

function typeLabel(type) {
  const labels = {
    volume_surge: "거래량 주장",
    orderbook_wall: "호가창 주장",
    price_movement: "가격 움직임",
    actor_intent: "세력/의도 주장",
    action_pressure: "행동 유도",
    generic_market_claim: "일반 주장"
  };
  return labels[type] || type;
}

function stateLabel(state) {
  const labels = {
    SUPPORTED: "지지됨",
    CONTRADICTED: "데이터 충돌",
    UNVERIFIABLE: "검증 불가",
    PENDING: "조건 대기",
    EXPIRED: "근거 만료",
    UNSUPPORTED_CONCLUSION: "근거 부족",
    DERIVED: "계산 결과"
  };
  return labels[state] || state;
}

function riskLabel(label) {
  const labels = {
    CONCLUSION_DEPENDS_ON_UNVERIFIABLE_CLAIMS: "검증 불가 근거 의존",
    KEY_EVIDENCE_EXPIRED: "핵심 근거 만료",
    CLAIMS_CONFLICT_WITH_MARKET_DATA: "시장 데이터와 충돌",
    CONCLUSION_HAS_DATA_SUPPORT: "데이터 근거 있음",
    CONCLUSION_SUPPORT_IS_WEAK: "결론 근거 약함"
  };
  return labels[label] || label || "분석 대기";
}

function parserSourceLabel(parser) {
  if (!parser) return "기본 parser";
  if (parser.source === "gemini") return "Gemini + Upbit 검증";
  if (parser.fallbackReason === "GEMINI_API_KEY is not set.") return "기본 parser";
  return "기본 parser로 fallback";
}

function fallbackReasonLabel(parser) {
  if (!parser?.fallbackReason) return "--";
  if (parser.fallbackReason === "GEMINI_API_KEY is not set.") return "Gemini 키 없음";
  return parser.fallbackReason;
}

function verdictTitle(summary) {
  const score = summary.conclusionSupportScore || 0;
  const dependency = summary.dependency || {};

  if (dependency.unverifiable >= 0.4) {
    return "결론이 확인 불가능한 주장에 많이 기대고 있습니다";
  }
  if (summary.counts?.contradicted > 0) {
    return "일부 핵심 주장이 현재 시장 데이터와 맞지 않습니다";
  }
  if (summary.counts?.expired > 0) {
    return "근거가 빠르게 낡아서 현재 판단에는 조심해야 합니다";
  }
  if (score >= 0.65) {
    return "결론을 받치는 데이터 근거가 비교적 뚜렷합니다";
  }
  if (score >= 0.35) {
    return "일부 근거는 있지만 결론까지는 아직 약합니다";
  }
  return "최종 결론을 뒷받침하는 근거가 부족합니다";
}

function graphSummary(summary) {
  const counts = summary.counts || {};
  return `지지 ${counts.supported || 0} · 충돌 ${counts.contradicted || 0} · 검증불가 ${
    counts.unverifiable || 0
  }`;
}

function evidenceText(claim) {
  if (claim.evidence) return `근거: ${claim.evidence}`;
  return "근거: 아직 설명 가능한 데이터가 없습니다.";
}

function setMetric(valueId, barId, value) {
  const percent = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  document.querySelector(`#${valueId}`).textContent = `${percent}%`;
  document.querySelector(`#${barId}`).style.width = `${percent}%`;
}

function stateColor(state) {
  const colors = {
    SUPPORTED: "#188a59",
    CONTRADICTED: "#c64343",
    UNVERIFIABLE: "#6f7787",
    PENDING: "#c57a12",
    EXPIRED: "#6554c0",
    UNSUPPORTED_CONCLUSION: "#c64343"
  };
  return colors[state] || "#2f68d8";
}

function wrapText(text, size, maxLines) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > size && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const clipped = lines.slice(0, maxLines);
    clipped[maxLines - 1] = `${clipped[maxLines - 1].slice(0, Math.max(0, size - 1))}…`;
    return clipped;
  }

  return lines;
}

function toPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
