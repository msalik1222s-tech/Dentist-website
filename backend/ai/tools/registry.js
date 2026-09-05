// The tool registry: one list of tools, one place they are dispatched.
//
// Tools are declared in a provider-neutral shape ({ name, description,
// parameters }) and the provider adapters translate that into whatever their
// vendor expects. Adding a capability means adding a tool file here — no other
// layer changes.

const { validate } = require("./validate");

const clinicTools = require("./clinic-tools");
const appointmentTools = require("./appointment-tools");
const supportTools = require("./support-tools");

const ALL = [...clinicTools.tools, ...appointmentTools.tools, ...supportTools.tools];

const byName = new Map(ALL.map((tool) => [tool.name, tool]));

// What the provider adapters get: schemas only, never the handlers.
function definitions() {
  return ALL.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

// Every failure comes back as { error } rather than a thrown exception: the
// error is fed to the model as a tool result so it can apologise, ask for a
// correction, or try a different slot. A thrown error would end the turn with
// nothing useful for the patient.
async function run(name, rawInput, ctx) {
  const tool = byName.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };

  const { valid, errors, value } = validate(tool.parameters, rawInput || {});
  if (!valid) return { error: errors.join(" ") };

  try {
    const result = await tool.handler(value, ctx);
    return result === undefined ? { success: true } : result;
  } catch (err) {
    // Handler errors are business rules the model should relay ("that slot is
    // already booked"), so the message is passed through. Anything with a
    // .code is an infrastructure failure and is replaced: those messages carry
    // connection strings and SQL.
    if (err.code) {
      console.error(`Tool ${name} failed:`, err.message);
      return { error: "The clinic system is temporarily unavailable. Offer to have the team call the patient back." };
    }
    return { error: err.message };
  }
}

module.exports = { definitions, run, names: () => Array.from(byName.keys()) };
