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

  try {
    const response = await fetch("/api/v1/claimgraph/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: symbolInput.value,
        text
      })
    });

    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "analysis failed");
    renderResult(result);
  } catch (error) {
    renderError(error);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "분석 실행";
  }
}

function renderResult(result) {
  const summary = result.summary;
  document.querySelector("#claimCoverage").textContent = toPercent(summary.claimCoverage);
  document.querySelector("#evidenceScore").textContent = toPercent(summary.evidenceSupportScore);
  document.querySelector("#conclusionScore").textContent = toPercent(summary.conclusionSupportScore);
  document.querySelector("#weakestPremise").textContent = summary.weakestPremiseText || "--";
  document.querySelector("#riskLabel").textContent = summary.riskLabel;
  document.querySelector("#assessment").textContent = summary.neutralAssessment;
  document.querySelector("#claimCount").textContent = `${summary.counts.totalClaims}개`;

  const snapshot = result.marketSnapshot || {};
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

  renderClaimList(result.graph.nodes);
  renderGraph(result.graph);
}

function renderError(error) {
  document.querySelector("#assessment").textContent = `분석 실패: ${error.message}`;
  document.querySelector("#riskLabel").textContent = "ERROR";
  renderGraph({ nodes: [], edges: [] });
}

function renderClaimList(nodes) {
  const list = document.querySelector("#claimList");
  const claims = nodes.filter((node) => node.id.startsWith("P"));

  if (!claims.length) {
    list.innerHTML = `<div class="claim-item"><span class="claim-id">EMPTY</span><div class="claim-text"><strong>명제가 없습니다.</strong><span>입력 글을 확인해 주세요.</span></div></div>`;
    return;
  }

  list.innerHTML = claims
    .map(
      (claim) => `
        <article class="claim-item">
          <span class="claim-id">${escapeHtml(claim.id)} · ${escapeHtml(typeLabel(claim.type))}</span>
          <div class="claim-text">
            <strong>${escapeHtml(claim.text)}</strong>
            <span>${escapeHtml(claim.evidence || "")}</span>
          </div>
          <span class="state-badge state-${claim.truthState}">${escapeHtml(claim.truthState)}</span>
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
    const meta = `${typeLabel(node.type)} · ${node.truthState}`;

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
    volume_surge: "거래량",
    orderbook_wall: "호가",
    price_movement: "가격",
    actor_intent: "행위자",
    action_pressure: "결론",
    generic_market_claim: "일반"
  };
  return labels[type] || type;
}

function stateColor(state) {
  const colors = {
    SUPPORTED: "#188a59",
    CONTRADICTED: "#c64343",
    UNVERIFIABLE: "#6f7787",
    PENDING: "#c57a12",
    EXPIRED: "#6554c0"
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
