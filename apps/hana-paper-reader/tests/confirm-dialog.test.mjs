import assert from "node:assert/strict";
import test from "node:test";
import { confirmAction } from "../ui/assets/confirm-dialog.js";

class Element extends EventTarget {
  constructor(tag, owner) { super(); this.tagName = tag; this.owner = owner; this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  remove() { this.owner.body.children = this.owner.body.children.filter(node => node !== this); }
  showModal() { if (this.owner.unsupported) throw new Error("dialog unavailable"); this.open = true; }
  focus() { this.owner.focused = this; }
  click() { this.dispatchEvent(new Event("click")); }
}
function documentFixture(unsupported = false) {
  const doc = { unsupported, defaultView: new EventTarget() };
  doc.createElement = tag => new Element(tag, doc);
  doc.body = new Element("body", doc);
  return doc;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function buttons(doc) { return doc.body.children[0].children[2].children; }

test("confirmation requires explicit consent and defaults focus to cancel", async () => {
  const doc = documentFixture();
  let mutation = 0;
  const result = confirmAction("<img src=x onerror=mutation()>", { document: doc }).then(ok => { if (ok) mutation++; return ok; });
  await tick();
  assert.equal(doc.body.children[0].children[1].textContent, "<img src=x onerror=mutation()>");
  assert.equal(doc.focused, buttons(doc)[0]);
  assert.equal(mutation, 0);
  buttons(doc)[0].click();
  assert.equal(await result, false);
  assert.equal(mutation, 0);
  assert.equal(doc.body.children.length, 0);
  const accepted = confirmAction("clear synthetic value", { document: doc });
  await tick();
  buttons(doc)[1].click();
  assert.equal(await accepted, true);
  assert.equal(doc.body.children.length, 0);
});

test("Escape/native close and unsupported dialogs never grant consent", async () => {
  for (const type of ["cancel", "close"]) {
    const doc = documentFixture();
    const result = confirmAction("destructive action", { document: doc });
    await tick();
    const event = new Event(type, { cancelable: true });
    doc.body.children[0].dispatchEvent(event);
    assert.equal(await result, false);
    if (type === "cancel") assert.equal(event.defaultPrevented, true);
  }
  assert.equal(await confirmAction("unsupported", { document: documentFixture(true) }), false);
});

test("concurrent confirmations are sequential and page unload cancels queued consent", async () => {
  const doc = documentFixture();
  const first = confirmAction("first", { document: doc });
  const second = confirmAction("second", { document: doc });
  await tick();
  assert.equal(doc.body.children.length, 1);
  buttons(doc)[0].click();
  assert.equal(await first, false);
  await tick();
  assert.equal(doc.body.children[0].children[1].textContent, "second");
  const third = confirmAction("third", { document: doc });
  doc.defaultView.dispatchEvent(new Event("pagehide"));
  assert.equal(await second, false);
  assert.equal(await third, false);
  assert.equal(doc.body.children.length, 0);
});
