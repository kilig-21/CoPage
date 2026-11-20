import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const heapUnits = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
const services = ['backend', 'mysql', 'redis', 'rabbitmq', 'elasticsearch', 'minio', 'minio-init']
const logging = { 'max-file': '3', 'max-size': '10m' }

export const compactResources = {
  COPAGE_BACKEND_MEM_LIMIT: '896m', COPAGE_BACKEND_CPUS: '0.75',
  COPAGE_MYSQL_MEM_LIMIT: '640m', COPAGE_MYSQL_CPUS: '0.5',
  COPAGE_REDIS_MEM_LIMIT: '128m', COPAGE_REDIS_CPUS: '0.25',
  COPAGE_RABBITMQ_MEM_LIMIT: '384m', COPAGE_RABBITMQ_CPUS: '0.35',
  COPAGE_ES_MEM_LIMIT: '896m', COPAGE_ES_CPUS: '0.75', COPAGE_ES_HEAP: '384m',
  COPAGE_MINIO_MEM_LIMIT: '256m', COPAGE_MINIO_CPUS: '0.25',
  COPAGE_MINIO_INIT_MEM_LIMIT: '96m', COPAGE_MINIO_INIT_CPUS: '0.15',
}

export function assertResourceConfig(config) {
  for (const name of services) {
    const service = config.services[name]
    assert.ok(Number(service.mem_limit) > 0 && Number(service.cpus) > 0, `${name} 需要 CPU 与内存限制`)
    assert.equal(service.logging.driver, 'json-file')
    assert.deepEqual(service.logging.options, logging)
  }
  const es = config.services.elasticsearch
  const heap = /^-Xms(\d+)([kmg]) -Xmx\1\2$/i.exec(es.environment.ES_JAVA_OPTS)
  assert.ok(heap && Number(heap[1]) * heapUnits[heap[2].toLowerCase()] <= Number(es.mem_limit) / 2,
    'ES 堆不应超过容器内存的一半')
}

export function runResourcesCheck({ docker, source }) {
  const config = JSON.parse(source(['config', '--format', 'json']).stdout)
  assertResourceConfig(config)
  for (const name of services) {
    const ids = source(['ps', '--all', '-q', name]).stdout.trim().split(/\s+/).filter(Boolean)
    assert.ok(ids.length > 0)
    for (const id of ids) {
      const actual = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', id]).stdout)
      assert.equal(actual.Memory, Number(config.services[name].mem_limit), name)
      assert.equal(actual.NanoCpus, Math.round(config.services[name].cpus * 1e9), name)
      assert.equal(actual.LogConfig.Type, 'json-file')
      assert.deepEqual(actual.LogConfig.Config, logging)
    }
  }
  const heap = JSON.parse(source(['exec', '-T', 'elasticsearch', 'curl', '-fsS',
    'http://localhost:9200/_nodes/_local/jvm?filter_path=nodes.*.jvm.mem.heap_max_in_bytes']).stdout)
  const nodes = Object.values(heap.nodes)
  assert.equal(nodes.length, 1)
  assert.ok(nodes[0].jvm.mem.heap_max_in_bytes <= Number(config.services.elasticsearch.mem_limit) / 2)

  const name = 'copage-log-qa-' + randomBytes(6).toString('hex')
  const id = docker(['run', '--detach', '--network', 'none', '--name', name, '--label', 'com.copage.validation=CODI-115',
    '--log-driver', 'json-file', '--log-opt', 'max-size=4k', '--log-opt', 'max-file=2',
    '--entrypoint', 'sh', 'redis:7.4.1-alpine', '-ec',
    'i=0; while test "$i" -lt 250; do printf "rotation-%03d %0200d\\n" "$i" 0; i=$((i+1)); done',
  ]).stdout.trim()
  try {
    assert.equal(docker(['wait', id]).stdout.trim(), '0')
    const output = docker(['logs', id]).stdout
    assert.ok(output.includes('rotation-249 '))
    assert.ok(!output.includes('rotation-000 '), '轮转后应删除最早日志')
  } finally {
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.copage.validation"}}', id]).stdout.trim(), 'CODI-115')
    docker(['rm', '--volumes', id])
  }
  console.log('PASS: 运行容器 CPU、内存上限和日志配置与 Compose 一致；短阈值实测旧日志轮转淘汰')
}
