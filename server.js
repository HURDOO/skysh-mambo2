const { server } = require("./backend/server");

const port = Number(process.env.PORT || 3000);

server.listen(port, () => {
  console.log(`ClaimGraph is running at http://localhost:${server.address().port}`);
});
