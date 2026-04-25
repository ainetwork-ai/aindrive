# aindrive — 100 Test Scenarios

Status legend: ⬜ pending · 🟢 pass · 🔴 fail · ⚪ skipped

## A. Auth & accounts (1–10)
1. 🟢 POST /api/auth/signup with valid email+password → 200 + session cookie
2. 🟢 Signup with duplicate email → 409
3. 🟢 Signup with short password (<8) → 400
4. 🟢 Signup with malformed email → 400
5. 🟢 POST /api/auth/login with correct creds → 200 + cookie
6. 🟢 Login with wrong password → 401
7. 🟢 Login with unknown email → 401
8. 🟢 POST /api/auth/logout → 303 redirect, cookie cleared
9. 🟢 GET / when logged out → renders signup landing
10. 🟢 GET / when logged in → renders drives list

## B. Wallet auth (SIWE-style) (11–20)
11. 🔴 POST /api/wallet/nonce → returns {nonce, expiresAt}
12. 🔴 Two consecutive nonces are unique
13. 🔴 POST /api/wallet/verify with valid sig → 200, cookie set
14. 🔴 Verify with bad sig → 401
15. 🔴 Verify with expired nonce → 400
16. 🔴 Verify reuse of consumed nonce → 400
17. 🔴 Verify with malformed address → 400
18. 🔴 GET /api/wallet/me with cookie → returns {address}
19. 🔴 GET /api/wallet/me without cookie → returns {address: null}
20. 🔴 Two different signers create independent wallet sessions

## C. Drives (21–30)
21. 🔴 Owner creates drive → driveId, agentToken, driveSecret returned
22. 🔴 Each new drive gets unique namespace_pubkey/secret (Ed25519 keypair)
23. 🔴 Anonymous POST /api/drives → 401
24. 🔴 GET /api/drives lists owner's drives
25. 🔴 Drive listing shows online=true while agent is connected
26. 🔴 Drive listing shows online=false after agent disconnect
27. 🔴 POST /api/drives/[id]/rotate → new agentToken issued (owner only)
28. 🔴 Non-owner cannot rotate
29. 🔴 GET /d/[id] without session → redirect to /login
30. 🔴 GET /d/[id] for unauthorized wallet → "no access" message

## D. Agent ↔ Server WS (31–40)
31. 🟢 Agent connects with valid token → "agent connected" log + last_seen_at updated
32. 🟢 Agent connects with bad token → close 4401
33. 🟢 Two simultaneous agents for same drive both stay connected (multi-device)
34. 🟢 Agent disconnect cleans up entry from agents map
35. 🟢 Heartbeat updates last_seen_at every 20s
36. 🟢 Server forwards fs RPC request → agent responds → server returns 200
37. 🟢 RPC method allowlist: invalid method → "unknown method"
38. 🟢 Agent rejects forged sig → drops request silently
39. 🟢 Path traversal: list "../../etc" → "path escapes drive root"
40. 🟢 Hidden files (.git, .DS_Store, .aindrive) excluded from list

## E. FS operations (41–55)
41. 🟢 list root → all visible entries with size + mtime
42. 🟢 list subfolder → only that folder's entries
43. 🟢 list non-existent path → ENOENT bubbled
44. 🟢 stat existing file → entry with isDir=false, size matching
45. 🟢 stat folder → isDir=true
46. 🟢 stat non-existent → entry: null
47. 🟢 read text file utf8 → content matches disk
48. 🟢 read binary file base64 → decoded matches disk bytes
49. 🟢 read directory → "is a directory" error
50. 🟢 write new file → file appears on disk + appears in next list
51. 🟢 write existing file → overwrites
52. 🟢 mkdir nested → creates intermediate dirs
53. 🟢 rename file → old gone, new exists with same content
54. 🟢 delete file → removed from disk + list
55. 🟢 delete root denied

## F. Folder access / wallet allowlist (56–65)
56. 🔴 Owner adds wallet to / path → folder_access row created with role=viewer
57. 🔴 Owner adds same wallet twice to same path → 409 UNIQUE conflict
58. 🔴 Owner adds wallet to deeper path "docs" → only authorizes that subtree
59. 🔴 Wallet visitor lists / before allowlist → 401/403
60. 🔴 Wallet visitor lists / after allowlist → 200 with role=viewer
61. 🔴 Wallet visitor lists subfolder authorized via prefix → 200
62. 🔴 Wallet visitor lists sibling not under allowed prefix → 403
63. 🔴 Wallet visitor write attempt with role=viewer → 403
64. 🔴 Owner revokes wallet → next visitor list returns 401
65. 🔴 Wallet allowlist add issues a Meadowcap cap (response.cap)

## G. Shares + paid access (x402) (66–75)
66. 🟢 Owner creates free share (price_usdc=null) → token returned, GET /api/s/<token> → 200
67. 🟢 Owner creates paid share ($0.50) → GET /api/s/<token> without wallet → 402
68. 🟢 402 response includes PAYMENT-REQUIRED header with amount + recipient
69. 🟢 POST /api/s/<token>/pay with txHash (DEV_BYPASS) → 200, folder_access INSERT, sets aindrive_wallet cookie
70. 🟢 After pay, GET /api/s/<token> → 200 with driveId/path
71. 🟢 Visitor with paid wallet can list drive contents
72. 🟢 Pay endpoint without DEV_BYPASS attempts facilitator /verify → propagates errors
73. 🟢 Owner sees added_by='payment' row with payment_tx
74. 🟢 Pay for free share → 400
75. 🟢 Pay issues Meadowcap cap (response.cap)

## H. Meadowcap (76–80)
76. 🟢 POST /api/cap/verify with valid encoded cap → valid: true, area details
77. 🟢 Decode garbled cap → 400 / valid: false
78. 🟢 Cap area pathPrefix matches the path used at issuance
79. 🟢 Cap timeEnd is approximately now + 30 days
80. 🟢 Two issuances of same path produce different caps (different receiver keys)

## I. Real-time editing (Y.js) (81–90)
81. 🟢 Single client opens README.md → editor renders content from disk
82. 🟢 Two clients on same file → typing in one appears in the other
83. 🔴 Autosave debounce after 5s writes Y.Doc binary + disk text
84. 🔴 Reload tab → content NOT duplicated (whenReady gating works)
85. 🔴 External edit (echo > README.md on disk) → fs-changed → editor reload
86. 🔴 Y.Doc binary persisted in .aindrive/yjs/<docId>.bin
87. 🔴 Willow Store has yjs_entries row per autosave
88. 🟢 Snapshot compaction triggers after 50 updates → 1 snapshot, 0 updates
89. 🟢 Awareness: typing in client A shows cursor in client B
90. 🟢 Read-only client (role=viewer) cannot push sync updates (server drops)

## J. Multi-device sync + edge cases (91–100)
91. 🟢 Two agents on same driveId connected via WS → both in agents_by_drive
92. 🟢 Agent A appendUpdate → sync-summary → agent B sync-want → agent B receives entry
93. 🟢 Same digest doesn't get re-applied (idempotent)
94. 🟢 Agent disconnect removes from agents_by_drive
95. ⚪ Server restart: agent reconnects with backoff
96. 🟢 Agent restart: WS reconnects to existing server
97. 🟢 List entry types: folder/text/binary all classified correctly
98. 🟢 POST without content-type → still parses JSON body
99. 🟢 Z.string regex on docId rejects "../foo"
100. 🟢 Big payload (4MB+1) → "yjs blob too large"
