const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const UPBIT_BASE_URL = "https://api.upbit.com";

const STATE_SCORE = {
  SUPPORTED: 1,
  CONTRADICTED: 0,
  UNVERIFIABLE: 0.05,
  PENDING: 0.35,
  EXPIRED: 0.1
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendStatic(res, filePath) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendJson(res, 404, { success: false, error: "NOT_FOUND" });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream"
    });
    res.end(buffer);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 150_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function httpsJson(pathname, timeoutMs = 4500) {
  const requestUrl = `${UPBIT_BASE_URL}${pathname}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      requestUrl,
      {
        headers: {
          accept: "application/json",
          "user-agent": "ClaimGraph-MVP/0.1"
        },
        timeout: timeoutMs
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Upbit returned ${res.statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Upbit request timed out."));
    });
    req.on("error", reject);
  });
}

function normalizeMarket(symbol) {
  const raw = String(symbol || "KRW-SOL").trim().toUpperCase();
  if (!raw) return "KRW-SOL";
  if (raw.includes("-")) return raw;
  return `KRW-${raw.replace(/^KRW/, "")}`;
}

async function loadMarketSnapshot(market) {
  const encodedMarket = encodeURIComponent(market);
  const snapshot = {
    market,
    fetchedAt: new Date().toISOString(),
    source: "upbit",
    available: false,
    ticker: null,
    orderbook: null,
    candles: [],
    metrics: null,
    errors: []
  };

  const requests = await Promise.allSettled([
    httpsJson(`/v1/ticker?markets=${encodedMarket}`),
    httpsJson(`/v1/orderbook?markets=${encodedMarket}`),
    httpsJson(`/v1/candles/minutes/1?market=${encodedMarket}&count=30`)
  ]);

  const [tickerResult, orderbookResult, candlesResult] = requests;

  if (tickerResult.status === "fulfilled") snapshot.ticker = tickerResult.value[0] || null;
  else snapshot.errors.push(`ticker: ${tickerResult.reason.message}`);

  if (orderbookResult.status === "fulfilled") snapshot.orderbook = orderbookResult.value[0] || null;
  else snapshot.errors.push(`orderbook: ${orderbookResult.reason.message}`);

  if (candlesResult.status === "fulfilled") snapshot.candles = candlesResult.value || [];
  else snapshot.errors.push(`candles: ${candlesResult.reason.message}`);

  snapshot.available = Boolean(snapshot.ticker || snapshot.orderbook || snapshot.candles.length);
  snapshot.metrics = buildMarketMetrics(snapshot);
  return snapshot;
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const middle = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[middle - 1] + nums[middle]) / 2 : nums[middle];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildMarketMetrics(snapshot) {
  const candles = snapshot.candles || [];
  const latest = candles[0] || null;
  const previous = candles.slice(1);
  const previousVolumes = previous.map((candle) => Number(candle.candle_acc_trade_volume || 0));
  const previousMedianVolume = median(previousVolumes) || 0;
  const latestVolume = Number(latest?.candle_acc_trade_volume || 0);
  const volumeRatio = previousMedianVolume > 0 ? latestVolume / previousMedianVolume : null;
  const oldClose = Number(candles[Math.min(candles.length - 1, 9)]?.trade_price || 0);
  const currentPrice = Number(snapshot.ticker?.trade_price || latest?.trade_price || 0);
  const priceChange10m = oldClose > 0 ? ((currentPrice - oldClose) / oldClose) * 100 : null;
  const previousHigh = Math.max(
    0,
    ...previous.slice(0, 20).map((candle) => Number(candle.high_price || 0))
  );
  const isRecentBreakout = currentPrice > 0 && previousHigh > 0 && currentPrice >= previousHigh;

  const orderbookUnits = snapshot.orderbook?.orderbook_units || [];
  const bidSizes = orderbookUnits.map((unit) => Number(unit.bid_size || 0));
  const askSizes = orderbookUnits.map((unit) => Number(unit.ask_size || 0));
  const totalBidSize = bidSizes.reduce((sum, value) => sum + value, 0);
  const totalAskSize = askSizes.reduce((sum, value) => sum + value, 0);
  const largestBidSize = Math.max(0, ...bidSizes);
  const medianBidSize = median(bidSizes) || 0;
  const bidAskRatio = totalAskSize > 0 ? totalBidSize / totalAskSize : null;
  const hasBidWall =
    orderbookUnits.length > 0 &&
    bidAskRatio !== null &&
    bidAskRatio >= 1.15 &&
    (medianBidSize === 0 || largestBidSize >= medianBidSize * 1.8);

  const now = Date.now();
  const orderbookTimestamp = Number(snapshot.orderbook?.timestamp || 0);
  const orderbookAgeSeconds = orderbookTimestamp ? Math.max(0, (now - orderbookTimestamp) / 1000) : null;
  const candleTimestamp = latest?.candle_date_time_utc ? Date.parse(`${latest.candle_date_time_utc}Z`) : 0;
  const candleAgeSeconds = candleTimestamp ? Math.max(0, (now - candleTimestamp) / 1000) : null;

  return {
    currentPrice,
    volumeRatio,
    latestVolume,
    previousMedianVolume,
    priceChange10m,
    previousHigh,
    isRecentBreakout,
    totalBidSize,
    totalAskSize,
    bidAskRatio,
    largestBidSize,
    medianBidSize,
    hasBidWall,
    orderbookAgeSeconds,
    candleAgeSeconds
  };
}

function splitPostIntoFragments(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])|\n|;|；|(?<=다\.)|(?<=요\.)/)
    .flatMap((sentence) => sentence.split(/\s*(?:그리고|또|특히|하지만|근데|,)\s*/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function parseClaims(text) {
  const fragments = splitPostIntoFragments(text);
  const claims = [];

  for (const fragment of fragments) {
    const detected = detectClaimTypes(fragment);
    for (const type of detected) {
      claims.push({
        id: `P${claims.length + 1}`,
        text: normalizeClaimText(fragment, type),
        type,
        sourceText: fragment
      });
    }
  }

  if (!claims.length && String(text || "").trim()) {
    claims.push({
      id: "P1",
      text: "게시글에 명시적인 데이터 검증 대상이 부족하다",
      type: "generic_market_claim",
      sourceText: String(text).slice(0, 120)
    });
  }

  return claims.slice(0, 12);
}

function detectClaimTypes(fragment) {
  const tests = [
    {
      type: "volume_surge",
      regex: /(거래량|거래대금|볼륨|체결).*?(터졌|터진|증가|급증|몰리|폭발|늘|붙)/
    },
    {
      type: "orderbook_wall",
      regex: /(매수벽|매도벽|호가|잔량|물량|벽).*?(두껍|얇|쌓|받치|비었|많|강하|약하)/
    },
    {
      type: "price_movement",
      regex: /(급등|상승|돌파|뚫|지지|전고점|신고가|저항|열려|간다|원|%)/
    },
    {
      type: "actor_intent",
      regex: /(세력|고래|기관|외국인|큰손|작전|매집|물량\s*흡수|누가\s*산)/
    },
    {
      type: "action_pressure",
      regex: /(지금|늦|타야|진입|사야|팔아야|무조건|안\s*타면|안\s*사면|가즈아|풀매수|손절)/
    }
  ];

  return tests.filter((test) => test.regex.test(fragment)).map((test) => test.type);
}

function normalizeClaimText(fragment, type) {
  const clean = fragment.replace(/[.!?。！？]+$/g, "").trim();
  if (clean.length <= 80) return clean;

  const labels = {
    volume_surge: "거래량 또는 거래대금 증가 주장",
    orderbook_wall: "호가창 매수/매도벽 주장",
    price_movement: "가격 움직임 또는 돌파 주장",
    actor_intent: "행위자 의도 또는 매집 주장",
    action_pressure: "투자 행동 유도 결론",
    generic_market_claim: "일반 투자 주장"
  };

  return labels[type] || clean.slice(0, 80);
}

function evaluateClaim(claim, snapshot) {
  switch (claim.type) {
    case "volume_surge":
      return evaluateVolumeClaim(claim, snapshot);
    case "orderbook_wall":
      return evaluateOrderbookClaim(claim, snapshot);
    case "price_movement":
      return evaluatePriceClaim(claim, snapshot);
    case "actor_intent":
      return {
        ...claim,
        verifiability: "UNVERIFIABLE",
        truthState: "UNVERIFIABLE",
        confidence: null,
        ttlSeconds: null,
        evidence: "공개 시세/호가 데이터만으로 매집 주체나 의도를 식별할 수 없습니다."
      };
    case "action_pressure":
      return {
        ...claim,
        verifiability: "UNVERIFIABLE",
        truthState: "UNVERIFIABLE",
        confidence: null,
        ttlSeconds: null,
        evidence: "투자 행동 유도 문장은 데이터 명제가 아니라 결론 압박 신호로 처리합니다."
      };
    default:
      return {
        ...claim,
        verifiability: "UNVERIFIABLE",
        truthState: "UNVERIFIABLE",
        confidence: null,
        ttlSeconds: null,
        evidence: "현재 MVP 규칙으로 검증 가능한 명제 타입에 포함되지 않습니다."
      };
  }
}

function evaluateVolumeClaim(claim, snapshot) {
  const ratio = snapshot.metrics?.volumeRatio;
  const age = snapshot.metrics?.candleAgeSeconds;
  const ttlSeconds = age === null ? null : Math.max(0, Math.round(15 * 60 - age));

  if (ratio === null) {
    return pendingClaim(claim, "거래량 캔들 데이터를 아직 가져오지 못했습니다.");
  }

  if (ttlSeconds !== null && ttlSeconds <= 0) {
    return expiredClaim(claim, "최근 캔들 데이터가 오래되어 현재 근거로 쓰기 어렵습니다.");
  }

  if (ratio >= 1.7) {
    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "SUPPORTED",
      confidence: clamp(0.55 + ratio / 5, 0.6, 0.93),
      ttlSeconds,
      evidence: `최근 1분 거래량이 이전 구간 중앙값의 ${ratio.toFixed(2)}배입니다.`
    };
  }

  if (ratio < 0.85) {
    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "CONTRADICTED",
      confidence: clamp(1 - ratio, 0.35, 0.84),
      ttlSeconds,
      evidence: `최근 1분 거래량이 이전 구간 중앙값의 ${ratio.toFixed(2)}배로, 증가 주장과 충돌합니다.`
    };
  }

  return {
    ...claim,
    verifiability: "VERIFIABLE",
    truthState: "PENDING",
    confidence: 0.42,
    ttlSeconds,
    evidence: `거래량 비율은 ${ratio.toFixed(2)}배로, 강한 증가라고 보기에는 아직 애매합니다.`
  };
}

function evaluateOrderbookClaim(claim, snapshot) {
  const metrics = snapshot.metrics;
  const age = metrics?.orderbookAgeSeconds;
  const ttlSeconds = age === null ? null : Math.max(0, Math.round(60 - age));

  if (!snapshot.orderbook || !metrics) {
    return pendingClaim(claim, "호가창 데이터를 아직 가져오지 못했습니다.");
  }

  if (ttlSeconds !== null && ttlSeconds <= 0) {
    return expiredClaim(claim, "호가창 주장은 수명이 짧고 현재 스냅샷이 만료되었습니다.");
  }

  const isBidWallClaim = /(매수|받치)/.test(claim.sourceText);
  const isThinAskClaim = /(매도벽.*얇|호가.*얇|매도.*비었)/.test(claim.sourceText);
  const bidAskRatio = metrics.bidAskRatio || 0;

  if ((isBidWallClaim || isThinAskClaim) && metrics.hasBidWall) {
    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "SUPPORTED",
      confidence: clamp(0.5 + bidAskRatio / 4, 0.58, 0.9),
      ttlSeconds,
      evidence: `상위 호가 기준 매수/매도 잔량 비율이 ${bidAskRatio.toFixed(2)}이고, 매수 잔량 집중이 감지되었습니다.`
    };
  }

  if ((isBidWallClaim || isThinAskClaim) && bidAskRatio < 0.95) {
    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "CONTRADICTED",
      confidence: clamp(1 - bidAskRatio, 0.38, 0.86),
      ttlSeconds,
      evidence: `상위 호가 기준 매수/매도 잔량 비율이 ${bidAskRatio.toFixed(2)}로, 매수벽 주장과 맞지 않습니다.`
    };
  }

  return {
    ...claim,
    verifiability: "VERIFIABLE",
    truthState: "PENDING",
    confidence: 0.4,
    ttlSeconds,
    evidence: `상위 호가 기준 매수/매도 잔량 비율은 ${bidAskRatio.toFixed(2)}입니다. 강한 벽으로 보기는 아직 부족합니다.`
  };
}

function evaluatePriceClaim(claim, snapshot) {
  const metrics = snapshot.metrics;
  const ttlSeconds =
    metrics?.candleAgeSeconds === null || metrics?.candleAgeSeconds === undefined
      ? null
      : Math.max(0, Math.round(10 * 60 - metrics.candleAgeSeconds));

  if (!metrics || !metrics.currentPrice) {
    return pendingClaim(claim, "현재가 데이터를 아직 가져오지 못했습니다.");
  }

  if (ttlSeconds !== null && ttlSeconds <= 0) {
    return expiredClaim(claim, "가격 움직임 검증에 쓰는 캔들 데이터가 만료되었습니다.");
  }

  const targetPrice = extractKrwPrice(claim.sourceText);
  if (targetPrice && /돌파|뚫/.test(claim.sourceText)) {
    if (metrics.currentPrice >= targetPrice) {
      return {
        ...claim,
        verifiability: "VERIFIABLE",
        truthState: "SUPPORTED",
        confidence: 0.78,
        ttlSeconds,
        evidence: `현재가 ${formatKrw(metrics.currentPrice)}가 주장 기준 ${formatKrw(targetPrice)} 이상입니다.`
      };
    }

    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "PENDING",
      confidence: 0.32,
      ttlSeconds,
      evidence: `현재가 ${formatKrw(metrics.currentPrice)}가 아직 주장 기준 ${formatKrw(targetPrice)}에 도달하지 않았습니다.`
    };
  }

  if (/급등|상승|간다|열려/.test(claim.sourceText)) {
    const change = metrics.priceChange10m;
    if (change !== null && change >= 1.2) {
      return {
        ...claim,
        verifiability: "VERIFIABLE",
        truthState: "SUPPORTED",
        confidence: clamp(0.55 + change / 10, 0.58, 0.92),
        ttlSeconds,
        evidence: `최근 약 10분 가격 변화율이 ${change.toFixed(2)}%입니다.`
      };
    }

    if (change !== null && change <= -0.4) {
      return {
        ...claim,
        verifiability: "VERIFIABLE",
        truthState: "CONTRADICTED",
        confidence: clamp(Math.abs(change) / 3, 0.4, 0.86),
        ttlSeconds,
        evidence: `최근 약 10분 가격 변화율이 ${change.toFixed(2)}%로 상승 주장과 충돌합니다.`
      };
    }
  }

  if (/전고점|신고가|돌파/.test(claim.sourceText) && metrics.isRecentBreakout) {
    return {
      ...claim,
      verifiability: "VERIFIABLE",
      truthState: "SUPPORTED",
      confidence: 0.69,
      ttlSeconds,
      evidence: `현재가가 최근 20개 1분 캔들의 고점권을 넘어섰습니다.`
    };
  }

  return {
    ...claim,
    verifiability: "VERIFIABLE",
    truthState: "PENDING",
    confidence: 0.36,
    ttlSeconds,
    evidence: "조건부 가격 주장이며, 현재 데이터만으로 결론이 발생했다고 보기 어렵습니다."
  };
}

function pendingClaim(claim, evidence) {
  return {
    ...claim,
    verifiability: "VERIFIABLE",
    truthState: "PENDING",
    confidence: 0.25,
    ttlSeconds: null,
    evidence
  };
}

function expiredClaim(claim, evidence) {
  return {
    ...claim,
    verifiability: "VERIFIABLE",
    truthState: "EXPIRED",
    confidence: 0.2,
    ttlSeconds: 0,
    evidence
  };
}

function extractKrwPrice(text) {
  const normalized = text.replace(/,/g, "");
  const manMatch = normalized.match(/(\d+(?:\.\d+)?)\s*만\s*원?/);
  if (manMatch) return Number(manMatch[1]) * 10_000;

  const wonMatch = normalized.match(/(\d{4,})\s*원?/);
  if (wonMatch) return Number(wonMatch[1]);

  return null;
}

function formatKrw(value) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function buildGraph(evaluatedClaims) {
  const conclusionSignals = evaluatedClaims.filter((claim) => claim.type === "action_pressure");
  const premises = evaluatedClaims.filter((claim) => claim.type !== "action_pressure");
  const conclusionText =
    conclusionSignals[0]?.text ||
    (premises.length ? "게시글의 투자 결론" : "검증 가능한 결론 부족");

  const edges = premises.map((claim) => ({
    from: claim.id,
    to: "C1",
    relation: "SUPPORTS",
    weight: edgeWeightForType(claim.type)
  }));

  const conclusionScore = calculateConclusionSupportScore(premises, edges);
  const conclusionNode = {
    id: "C1",
    text: conclusionText,
    type: "action_pressure",
    verifiability: "DERIVED",
    truthState: conclusionState(conclusionScore, premises),
    confidence: Number(conclusionScore.toFixed(2)),
    ttlSeconds: null,
    evidence: "전제 노드들의 상태와 가중치를 합산한 파생 결론입니다."
  };

  return {
    nodes: [...premises, conclusionNode],
    edges,
    conclusionNode,
    premises
  };
}

function edgeWeightForType(type) {
  const weights = {
    volume_surge: 0.28,
    orderbook_wall: 0.3,
    price_movement: 0.24,
    actor_intent: 0.38,
    generic_market_claim: 0.16
  };
  return weights[type] || 0.2;
}

function calculateConclusionSupportScore(premises, edges) {
  const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
  if (!premises.length || totalWeight === 0) return 0;

  const weighted = edges.reduce((sum, edge) => {
    const claim = premises.find((item) => item.id === edge.from);
    const stateScore = STATE_SCORE[claim?.truthState] ?? 0;
    const confidence = typeof claim?.confidence === "number" ? claim.confidence : 0.35;
    return sum + edge.weight * stateScore * confidence;
  }, 0);

  return clamp(weighted / totalWeight, 0, 1);
}

function conclusionState(score, premises) {
  if (!premises.length) return "UNVERIFIABLE";
  const unverifiableWeight = premises
    .filter((claim) => claim.truthState === "UNVERIFIABLE")
    .reduce((sum, claim) => sum + edgeWeightForType(claim.type), 0);
  const totalWeight = premises.reduce((sum, claim) => sum + edgeWeightForType(claim.type), 0) || 1;

  if (unverifiableWeight / totalWeight >= 0.45) return "UNVERIFIABLE";
  if (score >= 0.65) return "SUPPORTED";
  if (score <= 0.18) return "CONTRADICTED";
  return "PENDING";
}

function buildSummary(graph) {
  const claims = graph.premises;
  const total = claims.length || 1;
  const verifiable = claims.filter((claim) => claim.verifiability === "VERIFIABLE");
  const supported = claims.filter((claim) => claim.truthState === "SUPPORTED");
  const contradicted = claims.filter((claim) => claim.truthState === "CONTRADICTED");
  const expired = claims.filter((claim) => claim.truthState === "EXPIRED");
  const pending = claims.filter((claim) => claim.truthState === "PENDING");
  const unverifiable = claims.filter((claim) => claim.truthState === "UNVERIFIABLE");

  const claimCoverage = verifiable.length / total;
  const evidenceSupportScore = verifiable.length
    ? verifiable.reduce((sum, claim) => sum + (STATE_SCORE[claim.truthState] || 0), 0) / verifiable.length
    : 0;
  const conclusionSupportScore = graph.conclusionNode.confidence || 0;
  const weakestPremise = findWeakestPremise(claims);
  const dependsOnUnverifiable = dependencyShare(claims, "UNVERIFIABLE");
  const dependsOnExpired = dependencyShare(claims, "EXPIRED");

  const riskLabel = buildRiskLabel({
    weakestPremise,
    dependsOnUnverifiable,
    dependsOnExpired,
    conclusionSupportScore,
    contradictedCount: contradicted.length
  });

  return {
    claimCoverage: round2(claimCoverage),
    evidenceSupportScore: round2(evidenceSupportScore),
    conclusionSupportScore: round2(conclusionSupportScore),
    weakestPremise: weakestPremise?.id || null,
    weakestPremiseText: weakestPremise?.text || null,
    riskLabel,
    neutralAssessment: buildNeutralAssessment({
      supported,
      contradicted,
      pending,
      expired,
      unverifiable,
      weakestPremise,
      conclusionSupportScore,
      dependsOnUnverifiable
    }),
    counts: {
      totalClaims: claims.length,
      verifiable: verifiable.length,
      supported: supported.length,
      contradicted: contradicted.length,
      pending: pending.length,
      expired: expired.length,
      unverifiable: unverifiable.length
    },
    dependency: {
      unverifiable: round2(dependsOnUnverifiable),
      expired: round2(dependsOnExpired)
    }
  };
}

function findWeakestPremise(claims) {
  if (!claims.length) return null;

  return [...claims].sort((a, b) => {
    const aRisk = premiseRisk(a);
    const bRisk = premiseRisk(b);
    if (bRisk !== aRisk) return bRisk - aRisk;
    return edgeWeightForType(b.type) - edgeWeightForType(a.type);
  })[0];
}

function premiseRisk(claim) {
  const statePenalty = {
    UNVERIFIABLE: 1,
    CONTRADICTED: 0.9,
    EXPIRED: 0.72,
    PENDING: 0.48,
    SUPPORTED: 0.12
  };
  return (statePenalty[claim.truthState] || 0.3) * edgeWeightForType(claim.type);
}

function dependencyShare(claims, state) {
  const totalWeight = claims.reduce((sum, claim) => sum + edgeWeightForType(claim.type), 0);
  if (!totalWeight) return 0;
  const stateWeight = claims
    .filter((claim) => claim.truthState === state)
    .reduce((sum, claim) => sum + edgeWeightForType(claim.type), 0);
  return stateWeight / totalWeight;
}

function buildRiskLabel(input) {
  if (input.dependsOnUnverifiable >= 0.4) return "CONCLUSION_DEPENDS_ON_UNVERIFIABLE_CLAIMS";
  if (input.dependsOnExpired >= 0.3) return "KEY_EVIDENCE_EXPIRED";
  if (input.contradictedCount > 0) return "CLAIMS_CONFLICT_WITH_MARKET_DATA";
  if (input.conclusionSupportScore >= 0.65) return "CONCLUSION_HAS_DATA_SUPPORT";
  return "CONCLUSION_SUPPORT_IS_WEAK";
}

function buildNeutralAssessment(input) {
  const parts = [];

  if (input.supported.length) {
    parts.push(`${input.supported.length}개 주장은 현재 데이터로 지지됩니다`);
  }
  if (input.contradicted.length) {
    parts.push(`${input.contradicted.length}개 주장은 현재 데이터와 충돌합니다`);
  }
  if (input.expired.length) {
    parts.push(`${input.expired.length}개 주장은 근거 수명이 만료되었습니다`);
  }
  if (input.unverifiable.length) {
    parts.push(`${input.unverifiable.length}개 주장은 공개 데이터로 검증할 수 없습니다`);
  }
  if (!parts.length && input.pending.length) {
    parts.push(`${input.pending.length}개 주장은 조건 발생을 더 기다려야 합니다`);
  }

  const base = parts.length ? parts.join(", ") : "검증 가능한 명제가 충분히 추출되지 않았습니다";
  const weakest = input.weakestPremise
    ? ` 핵심 약한 고리는 "${input.weakestPremise.text}"입니다.`
    : "";
  const dependency =
    input.dependsOnUnverifiable >= 0.4
      ? " 결론이 검증 불가능한 전제에 크게 의존합니다."
      : "";

  return `${base}. 결론 근거 충족도는 ${Math.round(input.conclusionSupportScore * 100)}%입니다.${weakest}${dependency}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function analyzeClaimGraph(input) {
  const text = String(input.text || "").trim();
  if (!text) {
    const error = new Error("text is required");
    error.statusCode = 400;
    throw error;
  }

  const market = normalizeMarket(input.symbol);
  const rawClaims = parseClaims(text);
  const snapshot = await loadMarketSnapshot(market);
  const evaluatedClaims = rawClaims.map((claim) => evaluateClaim(claim, snapshot));
  const graph = buildGraph(evaluatedClaims);
  const summary = buildSummary(graph);

  return {
    success: true,
    symbol: market,
    generatedAt: new Date().toISOString(),
    marketSnapshot: {
      source: snapshot.source,
      available: snapshot.available,
      fetchedAt: snapshot.fetchedAt,
      currentPrice: snapshot.metrics?.currentPrice || null,
      volumeRatio: snapshot.metrics?.volumeRatio ? round2(snapshot.metrics.volumeRatio) : null,
      bidAskRatio: snapshot.metrics?.bidAskRatio ? round2(snapshot.metrics.bidAskRatio) : null,
      errors: snapshot.errors
    },
    graph: {
      nodes: graph.nodes,
      edges: graph.edges
    },
    summary
  };
}

async function routeApi(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    sendJson(res, 200, { success: true, service: "claimgraph-api" });
    return;
  }

  if (req.method === "POST" && req.url === "/api/v1/claimgraph/analyze") {
    try {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const result = await analyzeClaimGraph(payload);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        success: false,
        error: error.message || "ANALYSIS_FAILED"
      });
    }
    return;
  }

  sendJson(res, 404, { success: false, error: "API_ROUTE_NOT_FOUND" });
}

function routeStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const safePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const filePath = path.normalize(path.join(FRONTEND_DIR, safePath));

  if (!filePath.startsWith(FRONTEND_DIR)) {
    sendJson(res, 403, { success: false, error: "FORBIDDEN" });
    return;
  }

  sendStatic(res, filePath);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    routeApi(req, res);
    return;
  }

  routeStatic(req, res);
});

function listenWithFallback(port, attemptsLeft = 10) {
  const onError = (error) => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      listenWithFallback(port + 1, attemptsLeft - 1);
      return;
    }

    throw error;
  };

  const onListening = () => {
    server.off("error", onError);
    console.log(`ClaimGraph is running at http://localhost:${server.address().port}`);
  };

  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port);
}

if (require.main === module) {
  listenWithFallback(PORT);
}

module.exports = {
  analyzeClaimGraph,
  parseClaims,
  listenWithFallback,
  normalizeMarket,
  server
};
