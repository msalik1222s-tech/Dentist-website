// The Dental Care Assistant.
//
// This is the orchestration layer and nothing else: it knows the order of
// operations, and delegates every decision to a module that owns it.
//
//   input guard  -> is this message safe to send to a model at all?
//   memory       -> what happened earlier in this conversation?
//   persona      -> what should the system prompt say right now?
//   provider     -> generate (whichever LLM is configured)
//   tools        -> the only way to read or change clinic data
//   output guard -> is this reply safe to show a patient?
//
// No vendor name, no SQL, no HTTP and no prompt text appears below. Swapping
// the model, the database or the channel does not touch this file.

const config = require("./config");
const errors = require("./errors");
const providers = require("./providers");
const persona = require("./prompt/persona");
const memory = require("./memory/memory-manager");
const tools = require("./tools/registry");
const inputGuard = require("./guardrails/input-guard");
const outputGuard = require("./guardrails/output-guard");
const store = require("../store");

// Returned when the model keeps calling tools past the turn limit. Hitting
// this means something is wrong, so it points at a human rather than trying
// again.
const EXHAUSTED_REPLY =
  "I'm having trouble getting that done from here. Please call the clinic on {phone} and the team will sort it out for you straight away.";

function clinicPhone() {
  try {
    return store.getClinicInfo().phone || "";
  } catch {
    return "";
  }
}

// One line per turn, with no message content: enough to spot a pattern of
// injection attempts or a guard firing repeatedly, without putting patient
// conversations in the log.
function logTurn(conversation, entry) {
  const parts = [
    `session=${conversation.sessionId.slice(0, 8)}`,
    `channel=${conversation.channel}`,
    `verdict=${entry.verdict}`,
    `tools=${entry.toolCalls.join("|") || "-"}`,
    `turns=${entry.turns}`,
  ];
  if (entry.flags.length) parts.push(`flags=${entry.flags.join("|")}`);
  if (entry.violations.length) parts.push(`violations=${entry.violations.join("|")}`);
  console.log("[agent] " + parts.join(" "));
}

/**
 * Answer one patient message.
 *
 * @param {object} options
 * @param {string} options.message      what the patient said
 * @param {string} [options.sessionId]  existing session; omit to start one
 * @param {string} [options.channel]    "web" | "whatsapp"
 * @param {string} [options.externalId] channel-native id (a WhatsApp number),
 *                                      used to find the session instead of an id
 * @param {string} [options.locale]
 * @returns {Promise<{reply: string, sessionId: string, blocked: boolean, handoff: boolean}>}
 */
async function respond({ message, sessionId, channel = "web", externalId = null, locale = null }) {
  const provider = providers.getProvider();
  if (!provider.isConfigured()) throw errors.NOT_CONFIGURED();

  const conversation = await memory.open({ sessionId, channel, externalId, locale });

  const audit = { verdict: "clean", flags: [], toolCalls: [], violations: [], turns: 0 };

  // --- 1. screen the input -------------------------------------------------
  const screened = inputGuard.inspect(message);
  audit.verdict = screened.verdict;
  audit.flags = screened.flags || [];

  if (screened.verdict === "blocked") {
    // Recorded, so a pattern of attempts is visible in the transcript — but
    // never sent to the model, and it costs nothing.
    conversation.recordUser(screened.text || String(message).slice(0, 500), {
      blocked: true,
      reason: screened.reason,
    });
    conversation.recordAssistant(screened.reply, { canned: true, reason: screened.reason });
    await conversation.flush();
    logTurn(conversation, audit);
    return { reply: screened.reply, sessionId: conversation.sessionId, blocked: true, handoff: false };
  }

  // --- 2. fold anything that has aged out into the running summary ---------
  await memory.summariseIfNeeded(conversation, provider);

  // --- 3. build the prompt for this turn -----------------------------------
  const system = await persona.build({
    channel,
    session: conversation.session,
    reinforcement: inputGuard.reinforcement(screened.flags),
  });

  conversation.recordUser(screened.text, screened.flags.length ? { flags: screened.flags } : undefined);

  // --- 4. generate, running tools until the model has an answer ------------
  const turnMessages = conversation.history.slice();
  const toolDefinitions = tools.definitions();
  const toolOutputs = [];
  let handoffRequested = false;
  let replyText = "";

  for (let turn = 0; turn < config.maxToolTurns; turn += 1) {
    audit.turns = turn + 1;

    const completion = await provider.complete({
      system,
      messages: turnMessages,
      tools: toolDefinitions,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
    });

    if (!completion.toolCalls.length) {
      replyText = completion.text;
      break;
    }

    turnMessages.push({
      role: "assistant",
      content: completion.text,
      toolCalls: completion.toolCalls,
    });

    // Tools run in parallel: a turn often checks availability for two dates at
    // once, and they are independent.
    const results = await Promise.all(
      completion.toolCalls.map(async (call) => {
        audit.toolCalls.push(call.name);
        const output = await tools.run(call.name, call.input, conversation);
        if (call.name === "request_human_handoff" && output && output.success) handoffRequested = true;
        toolOutputs.push(output);
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(output),
          isError: !!(output && output.error),
        };
      })
    );

    conversation.recordToolUse(completion.toolCalls, results);
    turnMessages.push({ role: "tool", toolResults: results });

    // Last allowed turn and the model still wants tools: stop and escalate.
    if (turn === config.maxToolTurns - 1) {
      replyText = EXHAUSTED_REPLY.replace("{phone}", clinicPhone() || "the clinic");
      audit.violations.push("tool_turns_exhausted");
    }
  }

  // --- 5. screen the output ------------------------------------------------
  const checked = outputGuard.inspect(replyText, {
    allowedAmounts: outputGuard.collectAllowedAmounts(toolOutputs, screened.text),
    clinicPhone: clinicPhone(),
  });
  audit.violations.push(...checked.violations.map((v) => `${v.type}:${v.severity}`));

  conversation.recordAssistant(checked.text, {
    provider: provider.id,
    model: provider.model,
    toolCalls: audit.toolCalls,
    ...(checked.violations.length ? { violations: checked.violations } : {}),
  });

  await conversation.flush();
  logTurn(conversation, audit);

  return {
    reply: checked.text,
    sessionId: conversation.sessionId,
    blocked: false,
    handoff: handoffRequested || conversation.session.status === "handoff",
  };
}

// Everything a client needs to decide whether to show the chat widget, with no
// secrets in it.
function status() {
  const provider = providers.getProvider();
  return {
    enabled: provider.isConfigured() && !persona.isDegraded(),
    provider: provider.id,
    channels: ["web", ...(config.whatsapp.enabled ? ["whatsapp"] : [])],
    clinic: store.getClinicInfo().name,
  };
}

module.exports = { respond, status };
