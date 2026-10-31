import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceTokenEnvName, providerAdapter, verifyServiceIdentity, jobAllowedForTeam } from '../server/job-queue.js';

test('service identity tokens are scoped by explicit service id and require strong secrets',()=>{
 const name=serviceTokenEnvName('travel-search');
 assert.equal(name,'AVCU_SERVICE_TOKEN_TRAVEL_SEARCH');
 const old=process.env[name];
 delete process.env[name];
 assert.equal(verifyServiceIdentity('travel-search','anything'),false);
 process.env[name]='x'.repeat(48);
 assert.equal(verifyServiceIdentity('travel-search','x'.repeat(48)),true);
 assert.equal(verifyServiceIdentity('travel-search','y'.repeat(48)),false);
 if(old===undefined) delete process.env[name]; else process.env[name]=old;
});
test('provider adapters reject insecure or unapproved hosts',()=>{
 assert.throws(()=>providerAdapter('test',{baseUrl:'http://example.com',allowedHosts:['example.com'],tokenEnv:'TOKEN'}));
 assert.throws(()=>providerAdapter('test',{baseUrl:'https://example.com',allowedHosts:['other.example'],tokenEnv:'TOKEN'}));
});

test('job types cannot cross team boundaries',()=>{
 assert.equal(jobAllowedForTeam('travel','travel.search'),true);
 assert.equal(jobAllowedForTeam('communications','travel.search'),false);
 assert.equal(jobAllowedForTeam('risk-compliance','risk.evaluate'),true);
 assert.equal(jobAllowedForTeam('member-experience','risk.evaluate'),false);
});
