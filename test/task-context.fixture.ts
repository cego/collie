export const FIRST_SPEC = `# Handle duplicate refunds

## Objective

Refund a duplicate charge once per order.

## Done when

A repeated refund request leaves the order refunded once.

## Tickets

### 01: Refund a duplicate request

**Blocked by:** none
**Repo:** .
**Checks:** check

#### Acceptance criteria

- [ ] A second refund of one order refunds once.

#### After merge

- Observe a duplicate refund on a canary account.

### 02: Show the refund in the order's history

**Blocked by:** 01
**Repo:** .

#### Acceptance criteria

- [ ] The history lists one refund.
`;

export const SECOND_SPEC = `# Handle duplicate refunds

## Objective

Refund a duplicate charge once per order, even when the requests arrive together.

## Done when

Two simultaneous refund requests leave the order refunded once.

## Requirements

- Two concurrent refund requests must settle once.

## Tickets

### 01: Refund a duplicate request

**Blocked by:** none
**Repo:** .
**Checks:** check

#### Acceptance criteria

- [ ] A second refund of one order refunds once.

#### After merge

- Observe a duplicate refund on a canary account.

### 02: Show the refund in the order's history

**Blocked by:** 01
**Repo:** .

#### Acceptance criteria

- [ ] The history lists one refund.

### 03: Refund two concurrent requests

**Blocked by:** 01
**Repo:** .

#### Acceptance criteria

- [ ] Two requests arriving together refund once.
`;

export const SECOND_RATIONALE =
  "Refunds can arrive at the same time, so the guarantee needs a concurrency test.";
