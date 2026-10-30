// Clicks through the price-rules screen in a real DOM.
//
// Most of this screen's behaviour is script, not markup: a row opens an
// editor in place, that editor's worked example and info note must be its
// own, and the form at the top must be unaffected by both. Rendering the
// page and grepping the HTML -- which is all pytest can do on its own --
// proves none of that. So the Python test renders the page, writes it next
// to a small JSON plan naming the rules and steps it put on it, and this
// script drives the result.
//
// Usage: node drive_rules.js <plan.json>
// Prints one JSON object per check and exits non-zero if any failed.

const fs = require('fs');
const { JSDOM } = require('jsdom');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const html = fs.readFileSync(plan.html, 'utf8');

const crashes = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
dom.window.addEventListener('error', (event) => crashes.push(event.message));

const { document } = dom.window;
const q = (selector) => document.querySelector(selector);
const results = [];

function check(name, passed, detail) {
  results.push({ name: name, ok: !!passed, detail: detail === undefined ? null : String(detail) });
}

function fire(element, type) {
  element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

// ---------------------------------------------------------------- the rules

const first = plan.rules[0];
const second = plan.rules[1];
const firstEditor = q('[data-rule-edit="' + first.id + '"]');
const secondEditor = q('[data-rule-edit="' + second.id + '"]');
const firstRow = q('[data-rule-row="' + first.id + '"]');

check('every rule renders an editor of its own', !!firstEditor && !!secondEditor);
check('a rule editor starts closed', firstEditor.hidden === true);

q('[data-edit-rule="' + first.id + '"]').click();
check('Edit opens the editor in the row', firstEditor.hidden === false);
check('Edit stands the editor in for the display row', firstRow.hidden === true);

// The editor must carry the rule it belongs to, not whatever the form at the
// top happens to hold.
check(
  'the editor posts its own rule\'s derived location',
  firstEditor.querySelector('[name="derived_location"]').value === first.derived,
  firstEditor.querySelector('[name="derived_location"]').value
);
check(
  'the editor opens on its own reference',
  firstEditor.querySelector('[name="reference_location"]').value === first.reference,
  firstEditor.querySelector('[name="reference_location"]').value
);
check('the editor offers the reference but not the derived location',
  !!firstEditor.querySelector('[data-combo="reference"]') &&
  !firstEditor.querySelector('[data-combo="derived"]'));

// The worked example is the part that was wired to element ids, so every form
// on the screen drove the same one. Each must now be its own.
const firstSum = firstEditor.querySelector('[data-adjustment-sum]');
const topSum = q('#adjustment-sum');
const topSumAtStart = topSum.textContent;

check('the editor writes its own worked example', firstSum.textContent.trim().length > 0,
  firstSum.textContent.trim());
check('that example names this rule',
  firstSum.textContent.indexOf(first.derived) !== -1 ||
  firstSum.textContent.indexOf(first.reference) !== -1,
  firstSum.textContent.trim());
check('opening an editor leaves the top form\'s example alone',
  topSum.textContent.indexOf(first.derived) === -1, topSum.textContent.trim());

const amount = firstEditor.querySelector('[name="adjustment_value"]');
const exampleBefore = firstSum.textContent;
amount.value = '-25';
fire(amount, 'input');
check('typing an amount in the row rewrites the row\'s example',
  firstSum.textContent !== exampleBefore, firstSum.textContent.trim());
check('typing an amount in the row leaves the top form\'s example alone',
  topSum.textContent === topSumAtStart, topSum.textContent.trim());

const kind = firstEditor.querySelector('[name="adjustment_kind"]');
const beforeKind = firstSum.textContent;
kind.value = 'usd';
fire(kind, 'change');
check('changing the unit in the row rewrites the row\'s example',
  firstSum.textContent !== beforeKind, firstSum.textContent.trim());

// The combo inside a row has to find its own hidden input and its own note.
const combo = firstEditor.querySelector('[data-combo="reference"]');
combo.querySelector('.combo-field').click();
check('the row\'s combo opens', combo.querySelector('.combo-pop').hidden === false);

const options = combo.querySelectorAll('.combo-opt');
check('the row\'s combo lists locations', options.length > 0, options.length);
options[0].click();
check('picking in the row sets the row\'s own input',
  combo.querySelector('[name="reference_location"]').value.length > 0,
  combo.querySelector('[name="reference_location"]').value);
check('picking in the row does not touch the top form\'s input',
  q('#rule-form [name="reference_location"]').value === '',
  q('#rule-form [name="reference_location"]').value);
check('the row\'s info note is its own',
  firstEditor.querySelector('[data-note="reference"]').hidden === false);
check('the top form\'s info note stays hidden',
  q('#rule-form [data-note="reference"]').hidden === true);

// One at a time, and both ways of closing.
q('[data-edit-rule="' + second.id + '"]').click();
check('opening a second editor closes the first',
  firstEditor.hidden === true && secondEditor.hidden === false);

secondEditor.querySelector('[data-cancel-rule]').click();
check('Cancel closes the editor', secondEditor.hidden === true);
check('Cancel brings the display row back',
  q('[data-rule-row="' + second.id + '"]').hidden === false);

q('[data-edit-rule="' + first.id + '"]').click();
q('[data-edit-rule="' + first.id + '"]').click();
check('Edit a second time toggles the editor shut', firstEditor.hidden === true);

// ------------------------------------------------------------- the rounding

plan.rounding.forEach(function (step) {
  const editor = q('[data-rounding-edit="' + step.id + '"]');
  const row = q('[data-rounding-row="' + step.id + '"]');
  const label = 'rounding step #' + step.id + ': ';

  check(label + 'renders an editor of its own', !!editor);

  if (!editor) {
    return;
  }

  check(label + 'starts closed', editor.hidden === true);
  q('[data-edit-rounding="' + step.id + '"]').click();
  check(label + 'Edit opens it in the row', editor.hidden === false);
  check(label + 'Edit stands it in for the display row', row.hidden === true);
  check(label + 'posts its own location',
    editor.querySelector('[name="location"]').value === step.location,
    editor.querySelector('[name="location"]').value);
  check(label + 'offers all three directions',
    editor.querySelectorAll('[name="direction"]').length === 3,
    editor.querySelectorAll('[name="direction"]').length);
  check(label + 'opens on the direction it already has',
    editor.querySelector('[name="direction"]:checked').value === step.direction,
    editor.querySelector('[name="direction"]:checked').value);

  // A step of 0 is the "use it exactly as it is" choice: the box is ticked
  // and the step field greyed out, not a literal 0 to edit.
  const exact = editor.querySelector('[data-row-exact]');
  const field = editor.querySelector('[name="round_to_nearest"]');

  check(label + (step.exact ? 'opens on the exact tick' : 'opens on its step'),
    exact.checked === step.exact && field.disabled === step.exact,
    'ticked ' + exact.checked + ', field disabled ' + field.disabled);

  if (!step.exact) {
    check(label + 'opens on its own step', field.value === step.step, field.value);
  }

  exact.checked = !step.exact;
  fire(exact, 'change');
  check(label + 'the exact tick greys the step field',
    field.disabled === !step.exact, 'field disabled ' + field.disabled);

  editor.querySelector('[data-cancel-rounding]').click();
  check(label + 'Cancel closes it', editor.hidden === true);
});

// ------------------------------------------------- the form at the top still

const topAmount = q('#adjustment_value');
topAmount.value = '-10';
fire(topAmount, 'input');
check('the top form\'s own example still updates', topSum.textContent.indexOf('10') !== -1,
  topSum.textContent.trim());

q('#rule-form [data-combo="derived"] .combo-field').click();
const topOptions = document.querySelectorAll('#rule-form [data-combo="derived"] .combo-opt');
check('the top form\'s derived combo still lists locations', topOptions.length > 0, topOptions.length);
topOptions[0].click();
check('the top form\'s derived combo still sets its input',
  q('#rule-form [name="derived_location"]').value.length > 0,
  q('#rule-form [name="derived_location"]').value);

// A hidden input is exempt from the browser's own "please fill this in", so
// the screen checks it: submitting with no reference picked must be stopped.
let submitted = false;
const topForm = q('#rule-form');
topForm.addEventListener('submit', function (event) {
  submitted = true;
  event.preventDefault();
});
topForm.querySelector('[type="submit"]').click();
check('the top form refuses to submit with a location unpicked', submitted === false);

// ------------------------------------------------------------------- verdict

crashes.forEach(function (message) {
  check('the page threw: ' + message, false);
});

results.forEach(function (line) {
  console.log(JSON.stringify(line));
});

process.exit(results.some(function (line) { return !line.ok; }) ? 1 : 0);
