// Deterministic (no randomness) manifest builder for the Phase 2 labeled sample set.
// Produces fixtures/phase2/manifest.json: fixture *content* only (category/text/tags).
// Ground-truth boxes are NOT authored here -- they come from actually measuring the
// rendered pages (scripts/measure-phase2-fixtures.mjs), independent of any model output.
import { writeFile } from 'node:fs/promises';

const names = ['Priya Sharma', 'Rohan Verma', 'Ananya Iyer', 'Karan Mehta', 'Divya Nair',
  'Arjun Rao', 'Meera Pillai', 'Vikram Shah', 'Ishita Bose', 'Aditya Kulkarni'];
const streets = ['Vault Lane', 'Cedar Court', 'Harbor Walk', 'Elmwood Drive', 'Birchgate Road',
  'Marigold Street', 'Copper Ridge', 'Willowmere Ave', 'Foxglove Terrace', 'Granite Hollow'];
const cities = [
  ['Testville', '00001'], ['Sample City', '11112'], ['Rivergate', '22223'],
  ['North Haven', '33334'], ['Fernbrook', '44445'], ['Oakmoor', '55556'],
  ['Millfield', '66667'], ['Ashcombe', '77778'], ['Bellcross', '88889'], ['Thornwick', '99990'],
];
const inCities = [['Andheri, Mumbai', '400058'], ['Koramangala, Bengaluru', '560034'],
  ['Salt Lake, Kolkata', '700064'], ['Sector 62, Noida', '201309']];
const domains = ['example-mail.test', 'sample-inbox.test', 'mockdomain.test', 'testcorp.test'];

const addressText = (i, { multiline = false, indian = false } = {}) => {
  const num = 100 + i * 7;
  const street = streets[i % streets.length];
  if (indian) {
    const [area, pin] = inCities[i % inCities.length];
    return multiline ? `Flat ${num}, ${area}\n${pin}` : `Flat ${num}, ${area} - ${pin}`;
  }
  const [city, zip] = cities[i % cities.length];
  return multiline ? `${num} ${street}\n${city}, ST ${zip}` : `${num} ${street}, ${city} ${zip}`;
};
const phoneText = (i, variant) => {
  // Large, index-dependent multiplier so even short prefixes (used by the "split" fragments)
  // differ across indices -- a small linear increment left the leading digits identical.
  const digits = '9' + String(100000000 + (i * 87654321) % 900000000).padStart(9, '0');
  switch (variant) {
    case 'plain': return digits;
    case 'intl': return `+91 ${digits}`;
    case 'intlTight': return `+91${digits}`;
    case 'leadingZero': return `0${digits}`;
    case 'dashed': return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    default: return digits;
  }
};
const emailText = (i, { split = false } = {}) => {
  const local = names[i % names.length].toLowerCase().replace(' ', '.') + i;
  // Index suffix keeps every domain globally unique (a bare cycled domain would otherwise
  // repeat verbatim across tuning/holdout once more than `domains.length` samples exist).
  const domain = domains[i % domains.length].replace('.test', `-${i}.test`);
  return split ? { local, domain } : `${local}@${domain}`;
};

const entries = [];
const push = e => entries.push(e);

// --- Address: 6 tuning + 4 holdout ---
for (let i = 0; i < 10; i++) {
  const set = i < 6 ? 'tuning' : 'holdout';
  const indian = i % 3 === 0;
  const multiline = i % 4 === 1;
  const withName = i % 2 === 0;
  const tags = [];
  if (i === 2) tags.push('tiny');
  if (i === 8) tags.push('nonSquareDPR');
  const regions = [];
  if (withName) regions.push({ category: 'name-in-address', text: names[i % names.length], multiline: false });
  regions.push({ category: 'address', text: addressText(i, { multiline, indian }), multiline });
  push({
    id: `address-${set}-${String(i).padStart(2, '0')}`, set, primaryCategory: 'address',
    regions, hardNegative: false, benign: false, tags,
    referenceViewport: tags.includes('nonSquareDPR')
      ? { width: 900, height: 1200, devicePixelRatio: 1.5 } : { width: 1000, height: 800, devicePixelRatio: 1 },
    fontPx: tags.includes('tiny') ? 10 : 16, task: false,
  });
}

// --- Phone: 6 tuning + 4 holdout ---
const phoneVariants = ['plain', 'intl', 'intlTight', 'leadingZero', 'dashed'];
for (let i = 0; i < 10; i++) {
  const set = i < 6 ? 'tuning' : 'holdout';
  const variant = phoneVariants[i % phoneVariants.length];
  const split = i === 5 || i === 9;
  const regions = split
    ? [{ category: 'phone', text: phoneText(i, variant).slice(0, 5), multiline: false, note: 'first fragment, split across elements' },
       { category: 'phone', text: phoneText(i, variant).slice(5), multiline: false, note: 'second fragment, split across elements' }]
    : [{ category: 'phone', text: phoneText(i, variant), multiline: false }];
  push({
    id: `phone-${set}-${String(i).padStart(2, '0')}`, set, primaryCategory: 'phone',
    regions, hardNegative: false, benign: false, tags: split ? ['split'] : [],
    referenceViewport: { width: 1000, height: 800, devicePixelRatio: 1 }, fontPx: 16, task: false,
  });
}

// --- Email: 6 tuning + 4 holdout ---
for (let i = 0; i < 10; i++) {
  const set = i < 6 ? 'tuning' : 'holdout';
  const split = i === 3 || i === 7;
  const tags = [];
  if (i === 4) tags.push('tiny');
  if (i === 0) tags.push('mixed'); // also carries an address + phone region on the same page
  let regions;
  if (split) {
    const { local, domain } = emailText(i, { split: true });
    regions = [{ category: 'email', text: `${local}@`, multiline: false, note: 'local-part fragment, split across elements' },
               { category: 'email', text: domain, multiline: false, note: 'domain fragment, split across elements' }];
  } else {
    regions = [{ category: 'email', text: emailText(i), multiline: false }];
  }
  if (tags.includes('mixed')) {
    regions.push({ category: 'address', text: addressText(20 + i, {}), multiline: false });
    regions.push({ category: 'phone', text: phoneText(20 + i, 'intl'), multiline: false });
  }
  push({
    id: `email-${set}-${String(i).padStart(2, '0')}`, set, primaryCategory: 'email',
    regions, hardNegative: false, benign: false, tags,
    referenceViewport: { width: 1000, height: 800, devicePixelRatio: 1 },
    fontPx: tags.includes('tiny') ? 10 : 16, task: false,
  });
}

// --- Ambiguous-shaped content: 4 tuning + 4 holdout ---
// Not "safe to leave unflagged" -- offline-labeled as ambiguous so a conservative mask can be
// reported as a utility cost rather than penalized as a false positive or required to pass.
// Never used as the benign-survival control (see the unambiguous benign set below).
const ambiguous = [
  { text: 'Order #9876543210', note: '10-digit order id, phone-shaped' },
  { text: 'Ref No. 4455667788', note: '10-digit reference number, phone-shaped' },
  { text: 'The Old Mill Bakery, Founded 1958', note: 'address-shaped business description, no deliverable address' },
  { text: 'Riverside Bookstore & Cafe', note: 'address-shaped business name' },
  { text: '@sample_user posted a review', note: 'social handle, email-shaped @ sigil' },
  { text: 'Contact @support_desk for help', note: 'social handle, email-shaped @ sigil' },
  { text: 'Total: 411045 items in stock', note: 'postal-code-shaped number, quantity context' },
  { text: 'Invoice total ₹ 560034.00', note: 'postal-code-shaped number, price context' },
];
ambiguous.forEach((a, i) => {
  const set = i < 4 ? 'tuning' : 'holdout';
  push({
    id: `ambiguous-${set}-${String(i).padStart(2, '0')}`, set, primaryCategory: 'ambiguous',
    regions: [{ category: 'ambiguous', text: a.text, multiline: false, note: a.note }],
    hardNegative: true, benign: false, tags: [],
    referenceViewport: { width: 1000, height: 800, devicePixelRatio: 1 }, fontPx: 16, task: false,
  });
});

// --- All-benign control (unambiguous, no PII-shaped strings at all): 3 tuning + 3 holdout ---
const benignCopy = [
  'Your order has shipped and will arrive within 3-5 business days.',
  'Thank you for subscribing to our newsletter.',
  'This product is made from 100% recycled materials.',
  'Free returns within 30 days of delivery.',
  'Our support team is available Monday through Friday.',
  'Battery life: up to 12 hours on a single charge.',
];
benignCopy.forEach((text, i) => {
  const set = i < 3 ? 'tuning' : 'holdout';
  push({
    id: `benign-${set}-${String(i).padStart(2, '0')}`, set, primaryCategory: 'benign',
    regions: [{ category: 'benign', text, multiline: false }],
    hardNegative: false, benign: true, tags: [],
    referenceViewport: { width: 1000, height: 800, devicePixelRatio: 1 }, fontPx: 16,
    task: true, // benign pages carry the fill task, to measure utility/task-completion survival.
  });
});

const dup = new Map();
for (const e of entries) for (const r of e.regions) {
  const key = r.text.replace(/\s+/g, ' ').trim();
  if (dup.has(key)) throw new Error(`Duplicate secret string across fixtures: "${key}" in ${dup.get(key)} and ${e.id}`);
  dup.set(key, e.id);
}

const counts = entries.reduce((acc, e) => {
  acc[e.set] = (acc[e.set] || 0) + 1;
  return acc;
}, {});
console.log('Fixture counts:', counts, 'total', entries.length);

await writeFile(new URL('../fixtures/phase2/manifest.json', import.meta.url), JSON.stringify(entries, null, 2) + '\n');
