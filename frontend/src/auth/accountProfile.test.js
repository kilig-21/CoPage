import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAccountProfile } from './accountProfile.js'

const profile = { id: 12, username: 'owner', nickname: '原昵称😀', avatar: null }
const invalid = value => assert.rejects(Promise.resolve().then(() => parseAccountProfile(value)), error =>
  error.reason === 'ACCOUNT_PROFILE_RESPONSE' && error.code === undefined && /账号资料|回复/.test(error.message))

test('空、原始值和残缺资料均明确拒绝，不能被当成业务400', async () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'owner', [], {}, { data: profile },
    { id: 12 }, { username: 'owner' }]) await invalid(value)
})

test('编号必须是正安全整数，公开字段必须保持对应类型', async () => {
  for (const id of [undefined, null, false, '12', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await invalid({ ...profile, id })
  for (const username of [undefined, null, false, 12, {}, [], '', ' \t\n ']) await invalid({ ...profile, username })
  for (const field of ['nickname', 'avatar']) {
    for (const value of [false, 0, {}, []]) await invalid({ ...profile, [field]: value })
  }
})

test('兼容nullable字段、序列化省略null，以及既有内部控制字符和Unicode资料', () => {
  assert.deepEqual(parseAccountProfile({ id: 12, username: 'owner' }), { id: 12, username: 'owner', nickname: null, avatar: null })
  assert.deepEqual(parseAccountProfile({ ...profile, nickname: null }), { ...profile, nickname: null })
  const legacy = { id: 12, username: 'legacy\n用户😀', nickname: '旧\t昵称😀', avatar: 'https://example.test/头像.png' }
  assert.deepEqual(parseAccountProfile(legacy), legacy)
  assert.deepEqual(parseAccountProfile({ ...profile, nickname: '', avatar: '' }), { ...profile, nickname: '', avatar: '' })
})

test('只返回独立公开字段副本，不修改原值或暴露额外字段', () => {
  const value = Object.freeze({ ...profile, password: 'not-public', credentialVersion: 7, token: 'not-public', extra: { private: true } })
  const result = parseAccountProfile(value)
  assert.deepEqual(result, profile); assert.notEqual(result, value)
  assert.deepEqual(Object.keys(result).sort(), ['avatar', 'id', 'nickname', 'username'])
  result.nickname = '仅修改投影'
  assert.equal(value.nickname, profile.nickname); assert.equal(value.credentialVersion, 7)
})

test('保存回复必须对应原账号，不能把错账号或另一个id当成功', () => {
  assert.deepEqual(parseAccountProfile(profile, { expectedProfile: Object.freeze({ ...profile }) }), profile)
  for (const expectedProfile of [{ ...profile, id: 13 }, { ...profile, username: 'peer' }, {}, null]) {
    assert.throws(() => parseAccountProfile(profile, { expectedProfile }), error => error.reason === 'ACCOUNT_PROFILE_RESPONSE' && error.code === undefined)
  }
})

test('实际提交昵称逐字匹配，不用trim回复掩盖未确认结果', () => {
  const updated = { ...profile, nickname: '新昵称😀' }, expectedProfile = Object.freeze({ ...profile })
  assert.deepEqual(parseAccountProfile(updated, { expectedProfile, expectedNickname: '新昵称😀' }), updated)
  for (const expectedNickname of ['其他', ' 新昵称😀 ', null, 12]) {
    assert.throws(() => parseAccountProfile(updated, { expectedProfile, expectedNickname }), error => error.reason === 'ACCOUNT_PROFILE_RESPONSE')
  }
  for (const nickname of [null, undefined, ' 新昵称😀 ']) {
    assert.throws(() => parseAccountProfile({ ...updated, nickname }, { expectedNickname: '新昵称😀' }), error => error.reason === 'ACCOUNT_PROFILE_RESPONSE')
  }
  assert.equal(expectedProfile.nickname, profile.nickname)
})
