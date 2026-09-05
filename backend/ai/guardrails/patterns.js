// Pattern sets for the input and output guards, kept apart from the logic so
// they can be reviewed, extended and tested on their own.
//
// A note on what these are for. Prompt injection cannot be solved by pattern
// matching, and nothing here pretends otherwise — the real defences are
// structural: the model has no credentials, every tool validates its own
// input, writes re-check the database, and tool results are the only source of
// facts. These patterns are a cheap outer layer that catches the obvious
// attempts before they cost an API call, and a last check that an obviously
// bad string never reaches a patient.

// ---------------------------------------------------------------------------
// Input: attempts to override the agent's instructions or extract them
// ---------------------------------------------------------------------------

// High confidence. A patient asking about teeth does not write these.
// Matching one of these ends the turn with a canned refusal, without an API call.
const INJECTION_BLOCK = [
  /ignore\s+(all\s+)?(your\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(your\s+|the\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /(show|print|repeat|reveal|output|display|give)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions|rules|directive)/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions|initial\s+instructions)/i,
  /repeat\s+(everything|all\s+text)\s+(above|before)/i,
  /you\s+are\s+(now|no\s+longer)\s+(a|an|in)\s+/i,
  /\b(developer|debug|god|admin|maintenance)\s+mode\b/i,
  /\bDAN\s+mode\b/i,
  /pretend\s+(you\s+are|to\s+be)\s+(a|an)\s+(?!patient|dentist\b)/i,
  /act\s+as\s+(if\s+you\s+(are|were)\s+)?(an?\s+)?(unrestricted|uncensored|jailbroken)/i,
  /\bsudo\b\s+/i,
  /<\/?(system|instructions?)>/i,
  /\[\[?\s*system\s*\]?\]/i,
  /(reveal|show|print|leak|expose|dump)\s+(your\s+)?(api[\s_-]?key|secret|token|credential|env(ironment)?\s+var)/i,
  /(what|which)\s+(database|tables?|schema|columns?)\s+(do\s+you\s+|are\s+you\s+)?(use|using|have)/i,
  /\b(select|insert|update|delete|drop)\s+.{0,40}\bfrom\s+\w+/i,
  /\bunion\s+select\b/i,
  /process\.env/i,
];

// Lower confidence. These are allowed through, but the system prompt gets a
// reminder appended for that turn. A patient could plausibly write some of
// them by accident, so blocking would cost real conversations.
const INJECTION_FLAG = [
  /\bprompt\s+injection\b/i,
  /\byour\s+(real|true|actual)\s+(name|identity|purpose)\b/i,
  /\bare\s+you\s+(chatgpt|claude|gemini|gpt|an?\s+llm)\b/i,
  /\bwhat\s+model\s+are\s+you\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\boverride\b.{0,20}\b(rules?|policy|policies|guardrails?)\b/i,
  /\bfrom\s+now\s+on\b.{0,40}\byou\s+(will|must|should)\b/i,
  /\bfor\s+(testing|research)\s+purposes?\b.{0,40}\b(ignore|bypass|skip)\b/i,
  /\bhypothetically\b.{0,40}\b(no\s+rules|without\s+restrictions)\b/i,
];

// Things the agent is never allowed to do regardless of how nicely they are
// asked, and which a patient may genuinely ask for. These are not injection:
// they get a real, polite answer, so they are flagged rather than blocked and
// the prompt already covers the wording.
const POLICY_TOPICS = [
  { id: "discount", pattern: /\b(discount|cheaper|reduce\s+the\s+price|negotiate|deal|offer|coupon|promo)\b/i },
  {
    id: "prescription",
    pattern:
      /\b(prescribe|prescription|antibiotics?|painkillers?|amoxicillin|ibuprofen|paracetamol|medication|medicine)\b|\b(what|which)\s+(tablets?|pills?|drugs?)\b|\bshould\s+i\s+take\b/i,
  },
  { id: "diagnosis", pattern: /\b(what\s+(is\s+)?wrong\s+with\s+(me|my)|do\s+i\s+have|diagnos)/i },
];

// ---------------------------------------------------------------------------
// Output: things that must never reach a patient
// ---------------------------------------------------------------------------

// Secrets and infrastructure detail. A hit replaces the whole reply — there is
// no safe way to serve a message containing a live credential.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /postgres(ql)?:\/\/[^\s]+/i,
  /mongodb(\+srv)?:\/\/[^\s]+/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\b(ANTHROPIC|OPENAI|GOOGLE|GEMINI)_API_KEY\b/,
  /\bDATABASE_URL\b/,
  /\bADMIN_KEY\b/,
  /\bSMTP_(HOST|USER|PASS)\b/,
  /process\.env\.[A-Z_]+/,
];

// Internal structure: table names, SQL, tool plumbing, prompt scaffolding.
const INTERNALS_PATTERNS = [
  /\bCREATE\s+TABLE\b/i,
  /\bSELECT\s+[\w*,\s]+\s+FROM\s+(appointments|chat_sessions|chat_messages|handoffs|services|doctors|faqs|rate_limits|inbound_events)\b/i,
  /\b(chat_sessions|chat_messages|inbound_events|rate_limits|phone_digits)\b/,
  /\bMASTER SYSTEM PROMPT\b/i,
  /\bLIVE AUTHORIZED CLINIC DATABASE\b/i,
  /\bSYSTEM IDENTITY\b/i,
  /\bFINAL MASTER GUARDRAILS\b/i,
  /\byou are an AI Dental Assistant and virtual receptionist\b/i,
  /\binput_schema\b|\btool_use\b|\btool_result\b/,
];

// Clinical overreach. The agent may explain what a root canal is; it may not
// tell someone what they have or what to take.
const MEDICAL_PATTERNS = [
  // A dose is never appropriate from a receptionist.
  /\b\d+\s?(mg|ml|mcg)\b/i,
  /\btake\s+(two|three|2|3)?\s*(tablets?|pills?|capsules?)\b/i,
  /\bI\s+(can\s+)?prescribe\b/i,
  /\bI\s+(diagnose|am\s+diagnosing)\b/i,
  // "You have an abscess" — stated as fact, with no examination.
  /\byou\s+(definitely\s+|certainly\s+)?have\s+(an?\s+)?(abscess|infection|cavity|gum\s+disease|periodontitis|gingivitis|decay)\b/i,
  /\bthis\s+is\s+(definitely|certainly)\s+(an?\s+)?(abscess|infection|cavity)\b/i,
  /\byou\s+(do\s+not|don't)\s+need\s+to\s+see\s+a\s+dentist\b/i,
];

// Commitments the agent has no authority to make.
const COMMITMENT_PATTERNS = [
  /\bI\s+can\s+(give|offer)\s+you\s+a\s+(discount|special\s+price|deal)\b/i,
  /\b(\d+\s?%|percent)\s+off\b/i,
  /\bI\s+(can\s+)?(guarantee|promise)\s+(you\s+)?(a\s+)?(refund|cure|result|success)\b/i,
  /\bfree\s+of\s+charge\b/i,
];

module.exports = {
  INJECTION_BLOCK,
  INJECTION_FLAG,
  POLICY_TOPICS,
  SECRET_PATTERNS,
  INTERNALS_PATTERNS,
  MEDICAL_PATTERNS,
  COMMITMENT_PATTERNS,
};
