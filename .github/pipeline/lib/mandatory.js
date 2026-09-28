// Vendored unchanged from AvadoDServer/avado-release-control bot/lib/mandatory.js at 1313db3
// (the release watcher). Keep the two copies the same; fix bugs there first.

// Mandatory-release rules. Each rule reads ONE upstream release and says
// whether it is a mandatory upgrade, and until when.
//
//   avalanchego-deadline  "All Mainnet nodes must|should upgrade before 11 AM ET, September 22nd 2026."
//                         or the sentence every network upgrade carries:
//                         "The changes in the upgrade go into effect at <time> on <date> on Mainnet."
//   nearcore-header       the fenced header at the top of every nearcore release
//                         (CODE_RED_MAINNET, SECURITY_UPGRADE: TRUE, PROTOCOL_UPGRADE: TRUE)
//   qtum-block            "Mandatory update before Mainnet block 5483000"
//   release-wording       "mandatory", "must upgrade/update", "required update/upgrade",
//                         "should update as soon as possible", or Nimbus' "is a high-urgency
//                         release for <network>", in a sentence that applies to the row's
//                         network (not Hoodi, Sepolia, Fuji, testnets...)
//   fork-announcement     "upcoming ... hard fork" (backstop for Gnosis execution-only forks,
//                         such as the Balancer fork in Nethermind 1.35.7)
//
// A rule never lowers a version or skips a check; a false positive only
// means an URGENT email that turns out to be harmless. A confirmed false
// hit can be silenced per package with dismiss_mandatory in packages.yml.

const DAY = 24 * 3600 * 1000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// US Eastern time: DST from the second Sunday of March 02:00 to the first
// Sunday of November 02:00.
function easternOffsetHours(year, month, day, hour) {
  const nthSunday = (m, n) => {
    const first = new Date(Date.UTC(year, m, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 2);
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 2);
  const local = Date.UTC(year, month, day, hour);
  return local >= dstStart && local < dstEnd ? -4 : -5;
}

// Parses dates as written in release notes, for example
// "11 AM ET, September 22nd 2026", "Monday July 20th 00:00 UTC",
// "September 22, 2026 at 15:00 UTC", "2026-09-22". Returns a Date or null.
export function parseHumanDate(text, { defaultYear } = {}) {
  if (!text) return null;
  const s = text.replace(/\*/g, ' ').replace(/\s+/g, ' ').trim();
  let year; let month; let day;
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  } else {
    m = new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?(?:\\s+(\\d{4}))?`, 'i').exec(s);
    if (m) {
      month = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
      day = Number(m[2]);
      year = m[3] ? Number(m[3]) : null;
    } else {
      m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\\b,?(?:\\s+(\\d{4}))?`, 'i').exec(s);
      if (!m) return null;
      day = Number(m[1]);
      month = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
      year = m[3] ? Number(m[3]) : null;
    }
  }
  if (!year) {
    const y = /\b(20\d{2})\b/.exec(s);
    year = y ? Number(y[1]) : defaultYear;
  }
  if (!year || month < 0 || !day) return null;

  // Time of day: "11 AM", "11:30 am", "9:49:11 PM", "15:00", default midnight.
  let hour = 0; let minute = 0;
  const t12 = /\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)\b/i.exec(s);
  const t24 = /\b(\d{1,2}):(\d{2})\b/.exec(s);
  if (t12) {
    hour = Number(t12[1]) % 12 + (t12[3].toLowerCase() === 'pm' ? 12 : 0);
    minute = t12[2] ? Number(t12[2]) : 0;
  } else if (t24) {
    hour = Number(t24[1]);
    minute = Number(t24[2]);
  }
  let offset = 0;
  if (/\b(ET|EST|EDT|Eastern)\b/.test(s)) offset = /\bEST\b/.test(s) ? -5 : /\bEDT\b/.test(s) ? -4 : easternOffsetHours(year, month, day, hour);
  else if (/\b(PT|PST|PDT|Pacific)\b/.test(s)) offset = /\bPST\b/.test(s) ? -8 : easternOffsetHours(year, month, day, hour) - 3;
  else if (/\bCET\b/.test(s)) offset = 1;
  else if (/\bCEST\b/.test(s)) offset = 2;
  return new Date(Date.UTC(year, month, day, hour - offset, minute));
}

function sentences(body) {
  return (body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Markdown noise removed, full length (for matching).
function plain(s) {
  return s.replace(/^[>\s]+/, '').replace(/:warning:/g, '').replace(/\*+/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

export function cleanQuote(s) {
  return plain(s).slice(0, 300);
}

const OTHER_NETWORKS = /\b(hoodi|sepolia|holesky|goerli|prater|chiado|fuji|testnets?|devnets?|ropsten|kiln|ephemery)\b/i;
const GNOSIS = /\b(gnosis|xdai|gno)\b(?!\s+chiado)/i;
// "low-priority for mainnet, Prater users must upgrade" names mainnet only to exclude it.
const NOT_FOR_MAINNET = /\blow[- ](?:priority|urgency)\W{0,3}\s*(?:release\s+)?(?:for|on) mainnet|\bnot (?:required|mandatory|needed) (?:for|on) mainnet|\bno actions? (?:needed |required )?(?:for|on) (?:mainnet|other chains)/i;

// Does a sentence (or clause) apply to the row's network? A sentence that
// names no network applies to every network. `ethereumIsMainnet` is used for
// Nimbus' "high-urgency for Ethereum" wording.
function appliesTo(text, network, { ethereumIsMainnet = false } = {}) {
  const namesGnosis = GNOSIS.test(text);
  const namesMainnet = (/\bmainnets?\b/i.test(text) || (ethereumIsMainnet && /\bethereum\b/i.test(text))) && !NOT_FOR_MAINNET.test(text);
  const namesOther = OTHER_NETWORKS.test(text);
  return network === 'gnosis'
    ? namesGnosis || (!namesMainnet && !namesOther)
    : namesMainnet || (!namesGnosis && !namesOther);
}

// "This release is intended only for Gnosis Operators." limits a whole
// release to one network. Returns 'gnosis', 'ethereum-mainnet' or null.
export function releaseScope(body) {
  const b = plain(body || '');
  const m = /\b(?:intended|meant|relevant) only for ([^.\n]{1,60})|\bonly (?:intended |meant |relevant )?for ([^.\n]{1,40}?) (?:operators|users|nodes)\b/i.exec(b);
  if (!m) return null;
  const who = m[1] || m[2];
  const g = GNOSIS.test(who);
  const e = /\b(mainnet|ethereum)\b/i.test(who);
  if (g && !e) return 'gnosis';
  if (e && !g) return 'ethereum-mainnet';
  return null;
}

function inScope(release, network) {
  if (network === 'none') return true;
  const scope = releaseScope(release.body);
  return !scope || scope === network;
}

// --- rules -----------------------------------------------------------------

// AvalancheGo has written "should upgrade before" for most network upgrades
// (Cortina, Durango, Etna, Fortuna) and "must upgrade before" for the last
// two, so both count. Every network-upgrade release also says when the
// upgrade "goes into effect ... on Mainnet": that sentence alone is enough.
const AVAX_BEFORE = /\b(?:must|should|needs? to)\s+upgrade before\s+(.+)/i;
const AVAX_ACTIVATION = /\bgo(?:es)? into effect\b|\bschedules? the activation\b/i;

function avalanchegoDeadline(release) {
  const defaultYear = new Date(release.published_at).getUTCFullYear();
  const list = sentences(release.body).map(plain);
  const notTestnetOnly = (s) => /\bmainnet\b/i.test(s) || !OTHER_NETWORKS.test(s); // a Fuji-only sentence does not count
  for (const s of list) {
    const m = AVAX_BEFORE.exec(s);
    if (!m || !notTestnetOnly(s)) continue;
    const deadline = parseHumanDate(m[1], { defaultYear });
    return { mandatory: true, deadline, deadlineNote: deadline ? null : 'the date could not be read', quote: cleanQuote(s), rule: 'avalanchego-deadline' };
  }
  for (const s of list) {
    if (!AVAX_ACTIVATION.test(s) || !/\bon mainnet\b/i.test(s)) continue;
    // "... March 25th 2021 on the Fuji testnet and 10 AM EST, March 31st 2021 on mainnet": the Mainnet part.
    const part = OTHER_NETWORKS.test(s) ? s.split(/\band\b/i).find((x) => /\bon mainnet\b/i.test(x)) : s;
    const deadline = parseHumanDate(part, { defaultYear });
    return { mandatory: true, deadline, deadlineNote: deadline ? 'network upgrade activates on Mainnet' : 'the activation date could not be read', quote: cleanQuote(s), rule: 'avalanchego-deadline' };
  }
  return null;
}

export function parseNearHeader(body) {
  const m = /```[a-z]*\s*\n([\s\S]*?)```/.exec(body || '');
  if (!m) return null;
  const header = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Z_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) header[kv[1]] = kv[2];
  }
  return header.CODE_COLOR || header.RELEASE_VERSION ? header : null;
}

function nearcoreHeader(release) {
  const h = parseNearHeader(release.body);
  if (!h) return null;
  const colors = (h.CODE_COLOR || '').split(/[,\s]+/).filter(Boolean);
  const published = new Date(release.published_at);
  const plus7 = new Date(published.getTime() + 7 * DAY);
  const headerText = `CODE_COLOR: ${h.CODE_COLOR || '-'}, PROTOCOL_UPGRADE: ${h.PROTOCOL_UPGRADE || '-'}, SECURITY_UPGRADE: ${h.SECURITY_UPGRADE || '-'}`;
  if (h.PROTOCOL_UPGRADE === 'TRUE') {
    const vote = /Voting for protocol version \d+ will start on\s+\**([^*\n]+)\**/i.exec(release.body || '');
    const deadline = vote ? parseHumanDate(vote[1], { defaultYear: published.getUTCFullYear() }) : null;
    return {
      mandatory: true,
      deadline: deadline || plus7,
      deadlineNote: deadline ? 'protocol-upgrade voting starts' : 'no voting date found: release + 7 days',
      quote: vote ? cleanQuote(vote[0]) : headerText,
      rule: 'nearcore-header',
    };
  }
  if (colors.includes('CODE_RED_MAINNET') || h.SECURITY_UPGRADE === 'TRUE') {
    return { mandatory: true, deadline: plus7, deadlineNote: 'CODE_RED / security release: release + 7 days', quote: headerText, rule: 'nearcore-header' };
  }
  if (colors.includes('CODE_YELLOW_MAINNET')) {
    return { mandatory: false, soon: true, quote: headerText, rule: 'nearcore-header' };
  }
  return null;
}

export function qtumMandatoryBlock(body) {
  const m = /Mandatory update before\s+\(?(?:Mainnet)?\)?\s*block\s+([\d,]+)/i.exec(body || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function qtumBlock(release, ctx) {
  const block = qtumMandatoryBlock(release.body);
  if (!block) return null;
  const q = ctx?.qtum;
  let deadline = null;
  let deadlineNote;
  if (q && Number.isFinite(q.height)) {
    const secs = q.avgBlockSeconds || 32;
    deadline = new Date(q.now.getTime() + (block - q.height) * secs * 1000);
    deadlineNote = `block ${block}; chain height ${q.height}, about ${Math.round(secs)} s per block`;
  } else {
    deadlineNote = `block ${block}; the current Qtum block height could not be read`;
  }
  return { mandatory: true, deadline, deadlineNote, block, quote: `Mandatory update before Mainnet block ${block}`, rule: 'qtum-block' };
}

// "hard fork" alone is NOT used: release notes mention past forks all the
// time. Fork releases are covered by the fork schedule instead.
const WORDING = /\bmandatory\b|\bmust (?:be )?(?:upgrade|update)d?\b|\brequired (?:upgrade|update)\b|\b(?:upgrade|update|upgrading|updating) is required\b|\brequired for all\b|\bshould (?:upgrade|update) (?:as soon as possible|asap|immediately)\b/i;
// A clause that says the opposite; only that clause is dropped
// ("required update for Gnosis nodes, ..., optional otherwise" still counts for Gnosis).
const NEGATED = /\bnot (?:a |an |be )?(?:mandatory|required)\b|\bno(?:t)? (?:a )?required (?:upgrade|update)\b|\boptional\b|\bno longer (?:mandatory|required)\b|\bnon-mandatory\b/i;
// Changelog items about a feature, not about the release:
// "- Mandatory fee recipient: ...", "Make TLS mandatory by default (#8133)".
const CHANGELOG_ITEM = /^[-*•]\s*(?:mandatory|required)\b[^:]{0,40}:/i;
const PR_REF = /\(#\d+\)|\[[0-9a-f]{7,40}\]\(/i;
// Nimbus' boilerplate "`high-urgency`: update as soon as you can, ... required for Nimbus ..."
const URGENCY_GUIDE = /^(?:low|medium|high)[- ]urgency\s*:/i;
// Nimbus: "v25.4.1 is a high-urgency release for Ethereum and Gnosis mainnets", "It is high-urgency for Gnosis".
const HIGH_URGENCY = /\b(?:is an?|it is|it's)\s+high[- ]urgency\b(?:\s+(?:release|upgrade|update))?(?:\s+(?:for|on)\s+([^.]*))?/i;
// Chains AVADO does not run (Nethermind and others ship releases for them).
const NON_AVADO_CHAINS = /\b(op[- ]stack|op mainnet|base mainnet|optimism|energy web|volta|arbitrum|linea|taiko|lukso|scroll|unichain|world ?chain|zksync|polygon)\b/i;
const CONDITIONAL = /^(if|when|for those|only if|those users)\b|\bif you (are|want|use|run|plan)\b|\bonly (for|if) (users|nodes|operators) (using|running|who)\b|\bexperiencing\b/i;
// Something other than the node must change: AvalancheGo's "all plugins must
// update to be compatible", Grafana's "must update their database information".
const NOT_THE_NODE = /\bplugins? (?:must|should|need to)\b|\bplugin version is updated\b|\bmust update (?:their|your) (?:database|datasource|config|configuration|settings|dashboards?)\b/i;
// "high-urgency hotfix for users who run web3signer" is for some users only.
const URGENCY_CONDITIONAL = /\b(?:users?|those|operators|nodes) (?:who|that)\b|\bin (?:specific|some|certain) cases\b|\bother than\b/i;

// A release can say it several times; a sentence with a date wins.
function firstHit(found) {
  return found.find((h) => h.deadline) || found[0] || null;
}

function releaseWording(release, ctx) {
  const network = ctx?.network || 'ethereum-mainnet';
  if (!inScope(release, network)) return null;
  const defaultYear = new Date(release.published_at).getUTCFullYear();
  const hit = (s, extra = {}) => {
    const deadline = parseHumanDate(s, { defaultYear });
    return { mandatory: true, deadline, deadlineNote: deadline ? 'date taken from the release notes' : null, quote: cleanQuote(s), rule: 'release-wording', ...extra };
  };
  const found = [];
  for (const raw of sentences(release.body)) {
    const s = plain(raw);
    if (URGENCY_GUIDE.test(s) || CHANGELOG_ITEM.test(s) || PR_REF.test(s)) continue;
    const urgency = HIGH_URGENCY.exec(s);
    if (urgency) {
      if (!URGENCY_CONDITIONAL.test(s) && appliesTo(urgency[1] || '', network, { ethereumIsMainnet: true })) found.push(hit(s, { form: 'high-urgency' }));
      continue;
    }
    const kept = s.split(/[,;]\s+/).filter((clause) => !NEGATED.test(clause)).join(', ');
    if (!WORDING.test(kept)) continue;
    if (CONDITIONAL.test(kept) || NON_AVADO_CHAINS.test(kept) || NOT_THE_NODE.test(kept)) continue;
    if (!appliesTo(kept, network)) continue;
    found.push(hit(s));
  }
  return firstHit(found);
}

// Backstop for forks that no fork config shows (Gnosis execution-only forks):
// "- Upcoming Balancer Hardfork" in a release "intended only for Gnosis
// Operators", "the upcoming hard-fork on Gnosis". Generic text such as
// "chains relying on upcoming hardfork or EIP support" does not count.
const FORK_ANNOUNCE = /(?:^[-*•]?\s*|\b(?:the|an?|this)\s+)(?:upcoming|scheduled|planned)\b[^.\n]{0,40}\bhard[- ]?fork\b/i;

function forkAnnouncement(release, ctx) {
  const network = ctx?.network || 'ethereum-mainnet';
  if (!inScope(release, network)) return null;
  for (const raw of sentences(release.body)) {
    const s = plain(raw);
    if (!FORK_ANNOUNCE.test(s)) continue;
    if (/\bnot (?:yet )?scheduled\b|\bno date\b/i.test(s)) continue;
    if (CONDITIONAL.test(s) || NON_AVADO_CHAINS.test(s)) continue;
    if (!appliesTo(s, network)) continue;
    const deadline = parseHumanDate(s, { defaultYear: new Date(release.published_at).getUTCFullYear() });
    return { mandatory: true, deadline, deadlineNote: deadline ? 'date taken from the release notes' : 'fork date not in the notes', quote: cleanQuote(s), rule: 'fork-announcement' };
  }
  return null;
}

// Security hints (never an URGENT issue on their own; shown in the digest).
export function securityHint(release) {
  const b = release.body || '';
  const tags = [];
  if (/\bCVE-\d{4}-\d+/i.test(b)) tags.push('CVE');
  if (/\bGHSA-[\w-]+/i.test(b)) tags.push('GHSA');
  // Nimbus and Lighthouse state it in the first lines ("is a `high-urgency` release");
  // their "Urgency guidelines" boilerplate lists every level and must not count.
  if (/\bis an? `?high[- ]urgency`? (release|upgrade)(?! (for|on) (gnosis|hoodi|sepolia|holesky|testnets?))/i.test(b)) tags.push('high urgency');
  if (/\bis an? \**`?high[- ]priority`?\**\s*(release|upgrade)/i.test(b)) tags.push('high priority');
  if (/\bsecurity (?:fix|fixes|patch|patches|release|update|vulnerabilit(?:y|ies))\b/i.test(b)) tags.push('security fixes');
  if (/\bstrongly recommended (?:update|upgrade)\b/i.test(b)) tags.push('strongly recommended');
  if (/\+security/i.test(release.tag_name)) tags.push('security build');
  return tags;
}

const RULES = {
  'avalanchego-deadline': avalanchegoDeadline,
  'nearcore-header': nearcoreHeader,
  'qtum-block': qtumBlock,
  'release-wording': releaseWording,
  'fork-announcement': forkAnnouncement,
};

export const RULE_NAMES = [...Object.keys(RULES), 'fork-schedule'];

export function checkMandatory(release, ruleNames, ctx) {
  for (const name of ruleNames || []) {
    if (name === 'fork-schedule') continue; // handled by forks.js
    const rule = RULES[name];
    if (!rule) throw new Error(`unknown mandatory rule "${name}"`);
    const hit = rule(release, ctx);
    if (hit) return hit;
  }
  return null;
}
