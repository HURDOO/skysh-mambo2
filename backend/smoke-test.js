const { analyzeClaimGraph } = require("./server");

const sampleText =
  "솔라나 거래량 터졌다. 매수벽도 두껍고 18만 원 돌파하면 20만 원까지 열려 있다. 세력 매집 들어온 듯. 지금 안 타면 늦는다.";

analyzeClaimGraph({ symbol: "KRW-SOL", text: sampleText })
  .then((result) => {
    console.log(
      JSON.stringify(
        {
          success: result.success,
          symbol: result.symbol,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          riskLabel: result.summary.riskLabel,
          conclusionSupportScore: result.summary.conclusionSupportScore
        },
        null,
        2
      )
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
