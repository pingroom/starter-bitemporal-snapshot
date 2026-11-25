import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInput, timestamp, snapshotAt, snapshotPlan, requestFor, previewInput, hash } from '../src/model.js';
import { CONFIG, id } from '../src/mock.js';
const source = JSON.parse(await readFile(new URL('../examples/history.json', import.meta.url), 'utf8'));
const example = () => structuredClone(source);
const time = n => new Date(Date.UTC(2026, 0, 1) + n).toISOString();
const compact = () => ({ historyId:'example',title:'History',context:'Consult source.',facts:[{id:'fact',key:'paper',validFrom:time(2),validTo:time(6),revisions:[
  {recordedAt:time(1),kind:'assert',value:'old'}, {recordedAt:time(4),kind:'assert',value:'new'},
  {recordedAt:time(7),kind:'retract'}, {recordedAt:time(9),kind:'assert',value:'returned'}]}],
  profiles:[{id:'view',label:'View',reference:'Spec',effectiveAt:time(3),knownAt:time(5)}] });

test('same effective instant with later knowledge changes corrections and retractions', () => {
  const x = example();
  assert.deepEqual(snapshotAt(x,'original').rows.map(r=>[r.key,r.value]),[['ink','black'],['paper','A4']]);
  assert.deepEqual(snapshotAt(x,'corrected').rows.map(r=>[r.key,r.value]),[['ink','black'],['paper','A5']]);
  assert.deepEqual(snapshotAt(x,'later').rows.map(r=>[r.key,r.value]),[['paper','A5']]);
  assert.deepEqual(snapshotAt(x,'later').absentKeys,['ink']);
});
test('knowledge cutoff includes an exact revision timestamp but excludes the next millisecond', () => {
  const x=compact();x.profiles[0].knownAt=time(3);assert.equal(snapshotAt(x,'view').rows[0].value,'old');
  x.profiles[0].knownAt=time(4);assert.equal(snapshotAt(x,'view').rows[0].value,'new');
  x.profiles[0].knownAt=time(0);const a=snapshotAt(x,'view');assert.deepEqual(a.rows,[]);assert.deepEqual(a.absentKeys,['paper']);assert.equal(a.facts[0].status,'not-known');
});
test('effective interval includes start and excludes end, independently of knowledge time', () => {
  const x=compact();
  for(const [t,present] of [[1,false],[2,true],[5,true],[6,false]]) { x.profiles[0].effectiveAt=time(t);assert.equal(snapshotAt(x,'view').rows.length,present?1:0); }
});
test('retraction removes one fact and later reassertion restores it', () => {
  const x=compact();x.profiles[0].knownAt=time(7);let a=snapshotAt(x,'view');assert.deepEqual(a.absentKeys,['paper']);assert.equal(a.facts[0].status,'retracted');
  x.profiles[0].knownAt=time(9);a=snapshotAt(x,'view');assert.equal(a.rows[0].value,'returned');assert.equal(a.facts[0].revisionIndex,3);
});
test('overlapping facts remain ambiguous even when values match; no latest-overlap winner', () => {
  const x=compact();x.facts.push({...structuredClone(x.facts[0]),id:'other',revisions:[{recordedAt:time(5),kind:'assert',value:'new'}]});
  const a=snapshotAt(x,'view');assert.equal(a.consistent,false);assert.deepEqual(a.rows,[]);assert.deepEqual(a.absentKeys,[]);assert.equal(a.ambiguities[0].candidates.length,2);
  assert.equal(snapshotPlan(x,'view').status,'ambiguous');
  x.facts[1].revisions.push({recordedAt:time(6),kind:'retract'});x.profiles[0].knownAt=time(6);assert.equal(snapshotAt(x,'view').consistent,true);
});
test('adjacent intervals do not overlap and a retraction never removes another fact', () => {
  const x=compact();x.facts[0].revisions=[{recordedAt:time(1),kind:'retract'}];
  x.facts.push({id:'second',key:'paper',validFrom:time(6),validTo:time(10),revisions:[{recordedAt:time(0),kind:'assert',value:'next'}]});
  x.profiles[0].effectiveAt=time(6);assert.equal(snapshotAt(x,'view').rows[0].factId,'second');
  x.facts[0].revisions[0]={recordedAt:time(1),kind:'assert',value:'before'};assert.equal(snapshotAt(x,'view').rows[0].factId,'second');
});
test('a first retraction is allowed and does not invent earlier knowledge', () => {
  const x=compact();x.facts[0].revisions=[{recordedAt:time(4),kind:'retract'}];
  x.profiles[0].knownAt=time(3);assert.equal(snapshotAt(x,'view').facts[0].status,'not-known');
  x.profiles[0].knownAt=time(4);assert.equal(snapshotAt(x,'view').facts[0].status,'retracted');
});
test('known-at may precede effective-at for declarations recorded in advance', () => {
  const x=compact();x.profiles[0].knownAt=time(1);x.profiles[0].effectiveAt=time(5);
  assert.equal(snapshotAt(x,'view').rows[0].value,'old');
});
test('input canonicalization sorts fact IDs only and does not mutate caller data', () => {
  const x=example(),before=structuredClone(x),a=validateInput(x);assert.deepEqual(x,before);
  x.facts.reverse();assert.equal(hash(validateInput(x)),hash(a));
  x.profiles.reverse();assert.notEqual(hash(validateInput(x)),hash(a));
  x.facts[0].revisions.reverse();assert.throws(()=>validateInput(x),/increase/);
});
test('only canonical exact UTC millisecond domain timestamps are accepted', () => {
  for(const v of ['2026-01-01T00:00:00Z','2026-01-01T00:00:00.000+00:00','2026-02-30T00:00:00.000Z','2026-01-01T24:00:00.000Z','2026-01-01T00:00:00.000Z\n','+010000-01-01T00:00:00.000Z',null])assert.throws(()=>timestamp(v));
  assert.equal(timestamp('2000-02-29T00:00:00.000Z'),'2000-02-29T00:00:00.000Z');
  assert.equal(timestamp('0000-01-01T00:00:00.000Z'),'0000-01-01T00:00:00.000Z');
});
test('strict shapes, safe IDs, sparse arrays and invalid time intervals fail', () => {
  const mutations=[x=>{x.extra=1;},x=>{x.facts=[];},x=>{x.facts=new Array(1);},x=>{x.facts[0].revisions=new Array(1);},x=>{x.profiles=new Array(1);},
    x=>{x.facts.push(structuredClone(x.facts[0]));},x=>{x.facts[0].key='constructor';},x=>{x.facts[0].id+='\n';},x=>{x.title='History\u202e';},x=>{x.context='\ud800';},
    x=>{x.facts[0].validTo=x.facts[0].validFrom;},x=>{x.facts[0].revisions[1].recordedAt=x.facts[0].revisions[0].recordedAt;},
    x=>{x.facts[0].revisions[0].kind='delete';},x=>{x.facts[0].revisions[0]={kind:'retract',recordedAt:time(0),value:null};},x=>{delete x.facts[0].revisions[0].value;},
    x=>{x.profiles.push({...x.profiles[0],id:'other',label:'Other'});},x=>{x.profiles[0].id='unknown';},x=>{x.profiles[0].label='Unknown';},
    x=>{x.profiles[0].extra=1;},x=>{x.facts[0].extra=1;},x=>{x.facts[0].revisions[0].extra=1;}];
  for(const mutate of mutations){const x=compact();mutate(x);assert.throws(()=>validateInput(x));}
});
test('scalar assertions preserve exact values including null and escaped whitespace', () => {
  for(const value of [null,true,false,0,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER,'',' A\n\t\u0000B ','🙂']){
    const x=compact();x.facts[0].revisions=[{kind:'assert',recordedAt:time(1),value}];assert.equal(snapshotAt(x,'view').rows[0].value,value);
  }
  for(const value of [undefined,NaN,Infinity,1.5,-0,Number.MAX_SAFE_INTEGER+1,{},[],'x'.repeat(129),'\ud800']){
    const x=compact();x.facts[0].revisions[0].value=value;assert.throws(()=>validateInput(x));
  }
});
test('known selection gates results; exact metadata and hashes bind one direct Question', () => {
  const x=compact();assert.equal(snapshotPlan(x,null).status,'incomplete');assert.equal(snapshotPlan(x,'unknown').analysis,null);assert.throws(()=>snapshotAt(x,'missing'));
  const request=requestFor(x,CONFIG,'profile',id(1));assert.equal(request.ttl,900);assert.equal(request.target_user_id,CONFIG.participant.id);
  assert.deepEqual(request.options.map(o=>o.value),['view','unknown']);assert.match(request.prompt,/effective 2026-01-01T00:00:00.003Z; known 2026-01-01T00:00:00.005Z/);
  assert.equal(request.data.facts_hash,hash(validateInput(x).facts));assert.equal(previewInput(x,CONFIG).question.prompt,request.prompt);
  assert.equal(JSON.stringify(request).includes('returned'),false);assert.throws(()=>requestFor(x,CONFIG,'other',id(1)));
});
test('prompt length, revision count, fact count and profile count are bounded', () => {
  const mutations=[x=>{x.facts=Array.from({length:65},(_,i)=>({...x.facts[0],id:`f${i}`}));},
    x=>{x.facts[0].revisions=Array.from({length:9},(_,i)=>({kind:'assert',recordedAt:time(i),value:i}));},
    x=>{x.profiles=Array.from({length:4},(_,i)=>({...x.profiles[0],id:`p${i}`,label:`P${i}`,knownAt:time(i)}));},
    x=>{x.title='t'.repeat(40);x.context='c'.repeat(80);x.historyId='h'.repeat(40);x.profiles=Array.from({length:3},(_,i)=>({...x.profiles[0],id:`p${i}`,label:`P${i}`+'l'.repeat(22),reference:'r'.repeat(40),knownAt:time(i)}));}];
  for(const mutate of mutations){const x=compact();mutate(x);assert.throws(()=>validateInput(x));}
});
test('maximum pure input has bounded complete diagnostics and no omitted ambiguous candidates', () => {
  const x=compact();x.facts=Array.from({length:64},(_,i)=>({...x.facts[0],id:`f${String(i).padStart(2,'0')}`,revisions:Array.from({length:8},(_,j)=>({recordedAt:time(j),kind:'assert',value:'x'.repeat(128)}))}));
  x.profiles[0].knownAt=time(7);const a=snapshotAt(x,'view');assert.equal(a.ambiguities[0].candidates.length,64);assert.equal(a.facts.length,64);
  assert.ok(Buffer.byteLength(JSON.stringify({source:x,analysis:a},null,2)) < 300000);
  x.facts.forEach(fact => fact.revisions.forEach(revision => { revision.value = '\u0000'.repeat(128); }));
  assert.ok(Buffer.byteLength(JSON.stringify({source:x,analysis:snapshotAt(x,'view')},null,2)) < 750000);
});

function replayOracle(x, effectiveAt, knownAt) {
  const state=new Map();
  const events=x.facts.flatMap(f=>f.revisions.map(r=>({fact:f,...r}))).sort((a,b)=>a.recordedAt<b.recordedAt?-1:a.recordedAt>b.recordedAt?1:0);
  for(const event of events){if(event.recordedAt>knownAt)break;if(event.kind==='retract')state.delete(event.fact.id);else state.set(event.fact.id,event);}
  const groups=new Map();
  for(const e of state.values())if(e.fact.validFrom<=effectiveAt && effectiveAt<e.fact.validTo){const key=e.fact.key;if(!groups.has(key))groups.set(key,[]);groups.get(key).push([e.fact.id,e.value,e.recordedAt]);}
  const rows=[],ambiguous=[],absent=[];
  for(const key of [...new Set(x.facts.map(f=>f.key))].sort()){
    const candidates=(groups.get(key)??[]).sort((a,b)=>a[0]<b[0]?-1:1);
    if(candidates.length===0)absent.push(key);else if(candidates.length===1)rows.push([key,...candidates[0]]);else ambiguous.push([key,candidates]);
  }
  return {rows,ambiguous,absent};
}
const observed=a=>({rows:a.rows.map(r=>[r.key,r.factId,r.value,r.recordedAt]),ambiguous:a.ambiguities.map(g=>[g.key,g.candidates.map(r=>[r.factId,r.value,r.recordedAt])]),absent:a.absentKeys});
test('all 144 cutoff/effective crossings match an independent chronological-event replay', () => {
  const x=compact();x.facts.push({id:'overlap',key:'paper',validFrom:time(4),validTo:time(8),revisions:[{recordedAt:time(3),kind:'assert',value:5},{recordedAt:time(6),kind:'retract'}]});
  for(let valid=0;valid<12;valid++)for(let known=0;known<12;known++){
    x.profiles[0].effectiveAt=time(valid);x.profiles[0].knownAt=time(known);
    assert.deepEqual(observed(snapshotAt(x,'view')),replayOracle(x,time(valid),time(known)));
  }
});
test('300 seeded histories match independent event replay and ignore future corrections', () => {
  let seed=23231;const next=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let c=0;c<300;c++){
    const x=compact();x.facts=Array.from({length:1+next(8)},(_,i)=>{const from=next(9);let t=-1;return {id:`f${i}`,key:`k${next(4)}`,validFrom:time(from),validTo:time(from+1+next(5)),revisions:Array.from({length:1+next(5)},()=>{t+=1+next(3);return next(4)===0?{recordedAt:time(t),kind:'retract'}:{recordedAt:time(t),kind:'assert',value:next(7)};})};});
    x.profiles[0].effectiveAt=time(next(14));x.profiles[0].knownAt=time(next(14));
    assert.deepEqual(observed(snapshotAt(x,'view')),replayOracle(x,x.profiles[0].effectiveAt,x.profiles[0].knownAt));
    const original=observed(snapshotAt(x,'view'));x.facts[0].revisions.push({recordedAt:time(100),kind:'assert',value:'future'});assert.deepEqual(observed(snapshotAt(x,'view')),original);
  }
});
