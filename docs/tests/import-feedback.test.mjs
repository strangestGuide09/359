import assert from "node:assert/strict";
import test from "node:test";
import { clearImportFeedback, showImportFeedback } from "../import-feedback.js";

class FakeElement {
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.textContent = "";
  }
  set id(value) {
    if (this._id) this.document.nodes.delete(this._id);
    this._id = value;
    if (value) this.document.nodes.set(value, this);
  }
  get id() { return this._id || ""; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  replaceChildren(...children) { this.children = children; }
  insertAdjacentElement(_position, element) {
    this.document.hostChildren = this.document.hostChildren.filter(child => child !== element);
    this.document.hostChildren.push(element);
  }
  remove() {
    if (this.id) this.document.nodes.delete(this.id);
    this.document.hostChildren = this.document.hostChildren.filter(child => child !== this);
  }
  focus() {}
}

function fakeDocument() {
  const document = { nodes: new Map(), hostChildren: [] };
  document.createElement = tagName => new FakeElement(document, tagName);
  document.getElementById = id => document.nodes.get(id) || null;
  document.querySelector = selector => selector === ".primary-actions" ? document.actions : null;
  document.actions = document.createElement("nav");
  const status = document.createElement("p");
  status.id = "status";
  return document;
}

function fakeScheduler() {
  const callbacks = new Map();
  const cancelled = new Set();
  let nextId = 1;
  return {
    callbacks,
    cancelled,
    schedule(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    cancel(id) { cancelled.add(id); }
  };
}

test("duplicate feedback renders once, replaces itself, and automatically expires", () => {
  const document = fakeDocument();
  const timers = fakeScheduler();
  document.getElementById("status").textContent = "old duplicate copy";
  const options = { schedule: timers.schedule, cancel: timers.cancel, durationMs: 10000 };

  const first = showImportFeedback(document, "Already imported", "duplicate", options);
  const second = showImportFeedback(document, "Already imported again", "duplicate", options);

  assert.equal(first, second);
  assert.equal(document.hostChildren.length, 1);
  assert.equal(document.getElementById("status").textContent, "");
  assert.equal(second.children[0].textContent, "Already imported again");
  assert.deepEqual([...timers.cancelled], [1]);
  timers.callbacks.get(2)();
  assert.equal(document.getElementById("import-feedback"), null);
});

test("errors remain dismissible and auto-dismiss without affecting dialog validation", () => {
  const document = fakeDocument();
  const timers = fakeScheduler();
  const feedback = showImportFeedback(document, "Could not check receipt", "error", {
    schedule: timers.schedule,
    cancel: timers.cancel
  });

  assert.equal(timers.callbacks.size, 1);
  assert.equal(feedback.children.length, 2);
  assert.equal(feedback.children[1].attributes.get("aria-label"), "Dismiss notification");
  feedback.children[1].onclick();
  assert.equal(document.getElementById("import-feedback"), null);
  assert.deepEqual([...timers.cancelled], [1]);
  clearImportFeedback(document);
});
