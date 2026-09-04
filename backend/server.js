// Local/dev entry point — starts a persistent server. The Vercel deployment
// uses api/index.js instead, which exports the same app as a serverless
// function (no app.listen() there — Vercel's platform handles that part).
import { app } from "./app.js";

const port = process.env.PORT ?? 4000;
app.listen(port, () => {
  console.log(`rentFindr backend listening on http://localhost:${port}`);
});
