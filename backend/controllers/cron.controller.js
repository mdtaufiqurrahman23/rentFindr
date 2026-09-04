import { runScheduledReminders } from "../services/reminders.js";

export async function triggerScheduledReminders(req, res) {
  const summary = await runScheduledReminders();
  return res.json(summary);
}
