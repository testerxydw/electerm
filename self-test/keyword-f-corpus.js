// 批次 F 的 13 类真实输出冻结语料（V7 §6 批次 F）。
// 密度探针（keyword-density-demo.js E 段）与实机截图（keyword-f-demo.js）共用这份，
// 保证「数字报告」与「屏幕截图」逐行同源。后 3 类是批次 D 零命中删除造成的语料盲区
// （git diff / ssh 首连 / git log --oneline）——批次 G 已按用户裁决回表增补并在本语料上
// 复验着色（marker 层与 fingerprint 豁免覆盖率闸，见 keyword-scan.js）。
module.exports = [
  ['kubectl get pods', [
    'NAME                     READY   STATUS             RESTARTS   AGE',
    'web-0                    1/1     Running            0          3d4h',
    'worker-7f9c6d5b8-x2k4p   0/1     CrashLoopBackOff   12         5m',
    'init-job-28473920-abcde  0/1     Completed          0          2m',
    'redis-0                  1/1     Terminating        1          6d'
  ]],
  ['journalctl -u sshd', [
    'Nov 06 21:14:02 host sshd[2231]: Accepted password for dp25 from 10.1.2.3 port 52414 ssh2',
    'Nov 06 21:14:02 host sshd[2231]: pam_unix(sshd:session): session opened for user dp25(uid=1000)',
    'Nov 06 21:15:47 host sshd[2288]: Failed password for invalid user admin from 203.0.113.9 port 40012 ssh2',
    'Nov 06 21:15:49 host sshd[2288]: Connection closed by authenticating user admin 203.0.113.9 port 40012 [preauth]',
    'Nov 06 21:16:01 host sshd[2290]: Received disconnect from 10.1.2.3 port 52414:11: disconnected by user'
  ]],
  ['nginx access', [
    '10.1.2.3 - - [06/Nov/2026:21:14:02 +0800] "GET /api/users HTTP/1.1" 200 1234 "-" "curl/8.5.0" request_time=0.012',
    '203.0.113.9 - - [06/Nov/2026:21:15:47 +0800] "POST /login HTTP/1.1" 401 89 "-" "python-requests/2.31" request_time=0.340',
    '10.1.2.3 - - [06/Nov/2026:21:16:01 +0800] "GET /static/app.js HTTP/1.1" 304 0 "-" "Mozilla/5.0" request_time=0.002',
    '198.51.100.7 - - [06/Nov/2026:21:17:22 +0800] "GET /missing HTTP/1.1" 404 153 "-" "Wget/1.21" request_time=0.001'
  ]],
  ['ss -tunap', [
    'Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'tcp   LISTEN 0      4096   0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=901,fd=3))',
    'tcp   ESTAB  0      0      10.1.2.3:443        93.184.216.34:80 users:(("curl",pid=2231,fd=5))',
    'udp   UNCONN 0      0      127.0.0.53%lo:53    0.0.0.0:*     users:(("systemd-resolve",pid=600,fd=12))'
  ]],
  ['docker ps', [
    'CONTAINER ID   IMAGE          COMMAND                  CREATED        STATUS         PORTS                    NAMES',
    'a1b2c3d4e5f6   nginx:1.20     "/docker-entrypoint.…"   3 hours ago    Up 3 hours     0.0.0.0:8080->80/tcp     web-0',
    'f6e5d4c3b2a1   redis:7.2      "docker-entrypoint.s…"   2 days ago     Up 2 days      6379/tcp                 cache-0',
    '9a8b7c6d5e4f   postgres:16    "docker-entrypoint.s…"   5 minutes ago  Exited (1) 2 minutes ago               db-0'
  ]],
  ['git status', [
    'On branch feature/keyword-f',
    'Your branch is ahead of \'origin/master\' by 3 commits.',
    'Changes not staged for commit:',
    '  modified:   src/client/common/keyword-presets.js',
    '  deleted:    src/test/unit-ci/old.spec.js',
    'Untracked files:',
    '  self-test/f-shots/',
    'no changes added to commit (use "git add" and/or "git commit -a")'
  ]],
  ['mysql', [
    'mysql> SELECT id, name FROM users WHERE id = 42;',
    'ERROR 1146 (42S02): Table \'shop.users\' doesn\'t exist',
    'mysql> UPDATE users SET name = \'x\' WHERE id = 42;',
    'Query OK, 1 row affected (0.01 sec)',
    'mysql> SHOW PROCESSLIST;',
    '| 12 | root | 10.1.2.3:52414 | shop | Query | 2 | Using filesort | SELECT * FROM orders |'
  ]],
  ['dmesg', [
    '[    0.000000] Linux version 6.8.0-45-generic (buildd@lcy02-amd64) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0)',
    '[    1.234567] EXT4-fs (sda2): mounted filesystem with ordered data mode',
    '[   12.345678] i915 0000:00:02.0: [drm] Finished loading DMC firmware i915/adlp_dmc.bin (v2.20)',
    '[  345.678901] audit: type=1400 audit(1730899200.123:45): apparmor="DENIED" operation="open" profile="snap.foo" name="/etc/shadow"',
    '[  456.789012] Out of memory: Killed process 2231 (python3) total-vm:4096000kB'
  ]],
  ['pytest', [
    '============================= test session starts ==============================',
    'collected 42 items',
    'tests/test_api.py::test_login PASSED                                     [  2%]',
    'tests/test_api.py::test_logout FAILED                                    [  4%]',
    'E       AssertionError: assert 200 == 401',
    '========================= 1 failed, 41 passed in 3.45s ========================='
  ]],
  ['交换机 show ip int brief', [
    'Interface              IP-Address      OK? Method Status                Protocol',
    'Vlan10                 10.1.2.1        YES NVRAM  up                    up',
    'GigabitEthernet0/1     10.1.3.1        YES NVRAM  up                    up',
    'GigabitEthernet0/2     unassigned      YES unset  administratively down down',
    'Port-channel1          10.1.4.1        YES NVRAM  standby               up'
  ]],
  ['git diff（批次 G 回表：diff 头 / hunk / 冲突标记）', [
    'diff --git a/src/app.js b/src/app.js',
    'index 1a2b3c4..5d6e7f8 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -12,7 +12,8 @@ const init = () => {',
    '-  const port = 8080',
    '+  const port = 9090',
    '<<<<<<< HEAD',
    'const mode = "fast"',
    '=======',
    'const mode = "safe"',
    '>>>>>>> feature/safe'
  ]],
  ['ssh 首连（批次 G 回表：指纹）', [
    'The authenticity of host \'10.1.2.3 (10.1.2.3)\' can\'t be established.',
    'ED25519 key fingerprint is SHA256:4Kq9vX2mZ8bR1nT6wY3cJ5hL0pF7sD9gA2eU4iO6xQ8.',
    'This key is not known by any other names.',
    'Are you sure you want to continue connecting (yes/no/[fingerprint])?'
  ]],
  ['git log --oneline（批次 G 回表：短 sha / 分支引用）', [
    'b139c57e (HEAD -> master) refactor(keyword): 批次 D 数量收敛',
    '6a2074e4 refactor(db): 拆出 AI 登记 hook',
    '8e810ab4 docs(db): 校正主文件行数',
    'f0e67e55 (tag: v1.0.0, origin/master) release: 1.0.0',
    '2fd7400f feat: initial import'
  ]]
]
