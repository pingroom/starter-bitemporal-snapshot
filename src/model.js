import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = (value, max) => typeof value === 'string' && value.length <= max && /^[a-z][a-z0-9_-]*$(?![\s\S])/.test(value)
  && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scalar = value => value === null || typeof value === 'boolean'
  || Number.isSafeInteger(value) && !Object.is(value, -0)
  || typeof value === 'string' && value.length <= 128 && value.isWellFormed();
export function timestamp(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(raw)
    || !Number.isFinite(Date.parse(raw)) || new Date(Date.parse(raw)).toISOString() !== raw) throw new Error('Domain timestamps must be valid canonical millisecond UTC strings.');
  return raw;
}
export const POLICY = Object.freeze({ name: 'fixed-interval-bitemporal-snapshot-v1',
  knowledge: 'select the last revision of each fact whose recordedAt is less than or equal to knownAt',
  effective: 'a selected asserted fact is effective when validFrom <= effectiveAt < validTo',
  revision: 'revisions change the value or retract that fact; its key and valid interval remain fixed',
  ambiguity: 'two or more included facts for a key are ambiguous even when their values agree; withhold the complete snapshot',
  absence: 'no included fact means absent in the supplied history, not proof of real-world nonexistence',
  selection: 'one named owner selects a documented effectiveAt/knownAt pair; Unknown withholds analysis',
  excluded: 'database access, live time queries, interval inference, merging overlapping facts and changes to source records' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich view applies to ${input.historyId}?\n${input.profiles.map(p => `${p.label}: effective ${p.effectiveAt}; known ${p.knownAt}; ${p.reference}`).join('\n')}\nChoose Unknown if unverified. Fact values stay local.`;

export function validateInput(input) {
  if (!keys(input, ['historyId', 'title', 'context', 'facts', 'profiles']) || !word(input.historyId)
    || !line(input.title, 40) || !line(input.context, 80) || !Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > 64
    || !Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 3) throw new Error('Supply history metadata, one to 64 facts and one to three documented snapshot profiles.');
  const factIds = new Set();
  const facts = Array.from(input.facts, fact => {
    if (!keys(fact, ['id', 'key', 'validFrom', 'validTo', 'revisions']) || !safeId(fact.id, 24) || factIds.has(fact.id) || !safeId(fact.key, 24)
      || !Array.isArray(fact.revisions) || fact.revisions.length < 1 || fact.revisions.length > 8) throw new Error('Facts need unique IDs, keys and one to eight revisions.');
    timestamp(fact.validFrom); timestamp(fact.validTo);
    if (fact.validFrom >= fact.validTo) throw new Error('Every fact must have a nonempty half-open valid interval.');
    let previous = null;
    const revisions = Array.from(fact.revisions, revision => {
      if (revision?.kind === 'assert' ? !keys(revision, ['recordedAt', 'kind', 'value']) || !scalar(revision.value)
        : revision?.kind !== 'retract' || !keys(revision, ['recordedAt', 'kind'])) throw new Error('A revision must assert a scalar value or retract its fact without a value.');
      timestamp(revision.recordedAt);
      if (previous !== null && revision.recordedAt <= previous) throw new Error('Fact revision timestamps must increase strictly; they are never reordered.');
      previous = revision.recordedAt; return { ...revision };
    });
    factIds.add(fact.id); return { id: fact.id, key: fact.key, validFrom: fact.validFrom, validTo: fact.validTo, revisions };
  }).sort((a, b) => order(a.id, b.id));
  const profileIds = new Set(), labels = new Set(), pairs = new Set();
  const profiles = Array.from(input.profiles, profile => {
    if (!keys(profile, ['id', 'label', 'reference', 'effectiveAt', 'knownAt']) || !safeId(profile.id, 12) || profileIds.has(profile.id)
      || !line(profile.label, 24) || labels.has(profile.label) || profile.label.toLowerCase() === 'unknown' || !line(profile.reference, 40)) throw new Error('Profiles need unique IDs, labels, a reference and two explicit timestamps.');
    timestamp(profile.effectiveAt); timestamp(profile.knownAt);
    const pair = `${profile.effectiveAt}/${profile.knownAt}`;
    if (pairs.has(pair)) throw new Error('Snapshot profiles must have distinct effectiveAt/knownAt pairs.');
    profileIds.add(profile.id); labels.add(profile.label); pairs.add(pair); return { ...profile };
  });
  const result = { historyId: input.historyId, title: input.title, context: input.context, facts, profiles };
  if (promptFor(result).length > 500) throw new Error('Snapshot Question exceeds 500 UTF-16 units; shorten metadata or profile descriptions.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact history owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => { validateInput(input); return [{ id: 'profile' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'profile' || !isId(attemptId)) throw new Error('Invalid snapshot-profile selection or attempt.');
  const key = `bitemporal-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.profiles.map(profile => ({ value: profile.id, label: profile.label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), facts_hash: hash(input.facts), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'profile', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'Attempt UUID, correlation ID and input/facts/policy hashes are added when the session creates its Question.' };
}

export function snapshotAt(rawInput, profileId) {
  const input = validateInput(rawInput), profile = input.profiles.find(p => p.id === profileId);
  if (!profile) throw new Error('Select a declared snapshot profile before reconstructing history.');
  const included = new Map(), facts = [];
  for (const fact of input.facts) {
    let revisionIndex = -1;
    for (let i = 0; i < fact.revisions.length; i++) {
      if (fact.revisions[i].recordedAt > profile.knownAt) break;
      revisionIndex = i;
    }
    const revision = fact.revisions[revisionIndex];
    const status = !revision ? 'not-known' : revision.kind === 'retract' ? 'retracted'
      : fact.validFrom > profile.effectiveAt || fact.validTo <= profile.effectiveAt ? 'outside-valid-time' : 'included';
    facts.push({ factId: fact.id, key: fact.key, status, revisionIndex, recordedAt: revision?.recordedAt ?? null });
    if (status === 'included') {
      const row = { key: fact.key, value: revision.value, factId: fact.id, recordedAt: revision.recordedAt, validFrom: fact.validFrom, validTo: fact.validTo };
      if (!included.has(fact.key)) included.set(fact.key, []);
      included.get(fact.key).push(row);
    }
  }
  const rows = [], absentKeys = [], ambiguities = [];
  for (const key of [...new Set(input.facts.map(fact => fact.key))].sort(order)) {
    const candidates = included.get(key) ?? [];
    if (candidates.length === 0) absentKeys.push(key);
    else if (candidates.length === 1) rows.push(candidates[0]);
    else ambiguities.push({ key, candidates });
  }
  return { profile, consistent: ambiguities.length === 0, rows, absentKeys, ambiguities, facts,
    counts: { keys: rows.length + absentKeys.length + ambiguities.length, present: rows.length, absent: absentKeys.length, ambiguous: ambiguities.length },
    sourceHash: hash(input), policyHash: POLICY_HASH, sourceChanged: false,
    note: 'A reconstruction of the supplied history only; values are assertions, and absent keys may reflect incomplete exports.' };
}
export function snapshotPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !input.profiles.some(profile => profile.id === choice)) throw new Error('Supply a declared profile, Unknown or a missing selection.');
  const analysis = choice === null || choice === 'unknown' ? null : snapshotAt(input, choice);
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : analysis.consistent ? 'complete' : 'ambiguous', analysis };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed fact history. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved snapshot-profile selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'profile', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = snapshotPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, historyId: input.historyId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved snapshot-profile selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered snapshot-profile selections must not contain snapshot-profile selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
