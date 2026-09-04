// Vercel serverless entry point — Vercel's Node runtime treats a default
// export of an (req, res) handler as the function body, and an Express app
// instance is callable with exactly that signature, so exporting it directly
// works with no adapter needed.
import { app } from "../app.js";

export default app;
