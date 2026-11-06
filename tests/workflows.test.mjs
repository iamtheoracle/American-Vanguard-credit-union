import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTransition, buildStatusNotification, buildLoanSubmittedAlert } from "../src/domain/workflows.mjs";

test("operators may review a submitted loan but cannot final-approve it", () => {
  assert.equal(authorizeTransition({workflow:"loan",from:"submitted",to:"under_review",role:"operator"}).allowed, true);
  assert.deepEqual(authorizeTransition({workflow:"loan",from:"under_review",to:"approved",role:"operator"}), {allowed:false,reason:"role_not_permitted"});
});

test("management can approve a recommended loan", () => {
  assert.equal(authorizeTransition({workflow:"loan",from:"recommended",to:"approved",role:"management"}).allowed, true);
});

test("invalid transitions are denied", () => {
  assert.deepEqual(authorizeTransition({workflow:"loan",from:"rejected",to:"approved",role:"super_admin"}), {allowed:false,reason:"invalid_transition"});
  assert.deepEqual(authorizeTransition({workflow:"unknown",from:"submitted",to:"approved",role:"management"}), {allowed:false,reason:"unknown_workflow"});
});

test("approval and rejection create deterministic notification outbox records", () => {
  const event = buildStatusNotification({entityType:"loan",entityId:"loan-1",memberId:"member-1",memberEmail:"member@example.test",from:"under_review",to:"approved"});
  assert.equal(event.eventKey,"loan:loan-1:under_review:approved");
  assert.equal(event.templateKey,"loan_approved");
  assert.equal(buildStatusNotification({entityType:"loan",entityId:"loan-1",memberId:"member-1",memberEmail:"member@example.test",from:"under_review",to:"information_required"}), null);
});

test("loan submission creates one deterministic internal alert key", () => {
  const event = buildLoanSubmittedAlert({loanId:"loan-2",memberId:"member-2",amountMinor:250000,"currency":"USD"});
  assert.equal(event.eventKey,"loan:loan-2:submitted");
  assert.equal(event.templateKey,"loan_submitted_internal_alert");
  assert.throws(() => buildLoanSubmittedAlert({loanId:"loan-2",memberId:"member-2",amountMinor:0,currency:"USD"}), TypeError);
});
