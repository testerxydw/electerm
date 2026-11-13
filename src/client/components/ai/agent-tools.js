import { z } from '../../common/zod'
import { bookmarkSchemas } from '../../common/bookmark-schemas'
import { isExternalAlias } from '../../common/external-tool-guard'

function buildAddBookmarkParameters () {
  const typeProperties = {}
  for (const [type, schema] of Object.entries(bookmarkSchemas)) {
    typeProperties[type] = z.toJSONSchema(z.object(schema))
  }

  return {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: Object.keys(bookmarkSchemas),
        description: 'Bookmark type'
      },
      ...Object.fromEntries(
        Object.entries(typeProperties).map(([type, schema]) => [
          type,
          { type: 'object', description: `Fields for ${type} bookmark`, ...schema }
        ])
      )
    },
    required: ['type']
  }
}

function buildExportBookmarkParameters () {
  const types = Object.keys(bookmarkSchemas)
  const flag = description => ({
    type: 'boolean',
    description
  })
  return {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [...types, 'any'],
        description: 'Bookmark type to match, or "any" (default) for every type.'
      },
      types: {
        type: 'array',
        items: { type: 'string', enum: types },
        description: 'Match any of several types. Same meaning as type, for a list.'
      },
      keyword: {
        type: 'string',
        description: 'Case-insensitive match on title, host, username, url, path or description.'
      },
      host: {
        type: 'string',
        description: 'Host contains this text.'
      },
      port: {
        type: 'number',
        description: 'Exact port. Default ports are filled in, so 22 matches an ssh bookmark that left the port empty.'
      },
      username: {
        type: 'string',
        description: 'Username contains this text.'
      },
      group: {
        type: 'string',
        description: 'Bookmark category id or title.'
      },
      authType: {
        type: 'string',
        enum: ['password', 'privateKey', 'profiles'],
        description: 'Auth type configured on the bookmark.'
      },
      hasPrivateKey: flag('true: only bookmarks carrying private key content or a private key path. false: only those without.'),
      hasPassword: flag('true: only bookmarks with a saved password. false: only those without.'),
      hasCertificate: flag('true: only bookmarks with a certificate. false: only those without.'),
      hasProxy: flag('true: only bookmarks going through a proxy. false: only those without.'),
      hasSshTunnels: flag('true: only bookmarks with ssh tunnels defined. false: only those without.'),
      hasConnectionHoppings: flag('true: only bookmarks with connection hopping defined. false: only those without.'),
      hasQuickCommands: flag('true: only bookmarks with quick commands. false: only those without.'),
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Export exactly these bookmark ids.'
      }
    }
  }
}

export const agentTools = [
  {
    type: 'function',
    function: {
      name: 'send_terminal_command',
      description: 'Send a command to a terminal tab and wait for it to finish. Returns the command output. For long-running commands (builds, deployments, installations), use run_background_command instead to avoid timeouts.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          },
          tabId: {
            type: 'string',
            description: 'Terminal tab ID. Omit to use the active terminal.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_terminal_output',
      description: 'Read the current visible output from a terminal.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Terminal tab ID. Omit for active terminal.'
          },
          lines: {
            type: 'number',
            description: 'Number of recent lines to read (default 50).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_local_terminal',
      description: 'Open a new local terminal tab. Returns the new tab ID.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description: 'List all open terminal tabs with their IDs, titles, hosts, and types.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_active_tab',
      description: 'Get the currently active terminal tab.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: 'Switch to a different terminal tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'The tab ID to switch to.'
          }
        },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'close_tab',
      description: 'Close a terminal tab by its ID. Use this to clean up tabs after a task is finished.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'The tab ID to close.'
          }
        },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_bookmarks',
      description: 'List all saved bookmarks (SSH, Telnet, VNC, etc.).',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_bookmark',
      description: 'Open a saved bookmark as a new terminal tab.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The bookmark ID to open.'
          }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_bookmark',
      description: 'Create a new bookmark. Specify the type and provide type-specific fields. Supported types: ' + Object.keys(bookmarkSchemas).join(', ') + '.',
      parameters: buildAddBookmarkParameters()
    }
  },
  {
    type: 'function',
    function: {
      name: 'export_bookmarks',
      description: 'Open a panel that exports a filtered set of bookmarks to a JSON file. Use it when the user asks to export a subset of bookmarks, e.g. "all SSH bookmarks that use a private key": build the filter, call this once, and tell the user the panel is open. Matching runs inside the app, the user sees the matches and confirms the export there, and no bookmark field value (host, username, password, private key, ...) is returned to you.',
      parameters: buildExportBookmarkParameters()
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_tab',
      description: 'Open a terminal tab directly with connection parameters without creating a bookmark. Supported types: ' + Object.keys(bookmarkSchemas).join(', ') + '.',
      parameters: buildAddBookmarkParameters()
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_list',
      description: 'List files and directories at a remote path via SFTP. Requires an SSH/FTP tab.',
      parameters: {
        type: 'object',
        properties: {
          remotePath: {
            type: 'string',
            description: 'Remote directory path to list.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_stat',
      description: 'Get file/directory stats (size, permissions, etc.) at a remote path via SFTP.',
      parameters: {
        type: 'object',
        properties: {
          remotePath: {
            type: 'string',
            description: 'Remote path to stat.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_read_file',
      description: 'Read the contents of a remote file via SFTP.',
      parameters: {
        type: 'object',
        properties: {
          remotePath: {
            type: 'string',
            description: 'Remote file path to read.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_del',
      description: 'Delete a remote file or directory via SFTP.',
      parameters: {
        type: 'object',
        properties: {
          remotePath: {
            type: 'string',
            description: 'Remote file or directory path to delete.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_upload',
      description: 'Upload a local file to a remote server via SFTP.',
      parameters: {
        type: 'object',
        properties: {
          localPath: {
            type: 'string',
            description: 'Local file path to upload.'
          },
          remotePath: {
            type: 'string',
            description: 'Remote destination path.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['localPath', 'remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_download',
      description: 'Download a remote file to a local path via SFTP.',
      parameters: {
        type: 'object',
        properties: {
          remotePath: {
            type: 'string',
            description: 'Remote file path to download.'
          },
          localPath: {
            type: 'string',
            description: 'Local destination path.'
          },
          tabId: {
            type: 'string',
            description: 'SSH/FTP tab ID. Omit to use the active tab.'
          }
        },
        required: ['remotePath', 'localPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_transfer_list',
      description: 'List current active SFTP file transfers.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_transfer_history',
      description: 'List past SFTP file transfer history.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_terminal_status',
      description: 'Check terminal status: running (actively receiving data), idle, or password prompt. Returns last 20 lines of output. Lightweight, non-blocking.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Tab ID. Omit for active terminal.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_terminal_command',
      description: 'Cancel the running command in a terminal by sending Ctrl+C.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Tab ID. Omit for active terminal.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_terminal_keepalive',
      description: 'Turn session keepalive on or off for a terminal. While on, a newline is written to the session whenever it has been idle, resetting shell idle timeouts so the connection is not killed. Use it before long work on a session nobody is typing into, e.g. a large SFTP transfer.',
      parameters: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true to start sending keepalive, false to stop.'
          },
          tabId: {
            type: 'string',
            description: 'Tab ID. Omit for active terminal.'
          }
        },
        required: ['enabled']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_background_command',
      description: 'Run a command in the background using nohup. The terminal is freed immediately. Returns a taskId for monitoring. Use get_background_task_status and get_background_task_log to check progress.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run in the background.'
          },
          tabId: {
            type: 'string',
            description: 'Tab ID. Omit for active terminal.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_background_task_status',
      description: 'Check if a background task is running, completed (with exit code), or unknown.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'Task ID from run_background_command.'
          }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_background_task_log',
      description: 'Read the output log of a background task. Returns the last N lines.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'Task ID from run_background_command.'
          },
          lines: {
            type: 'number',
            description: 'Number of recent lines to read (default 100).'
          }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_background_task',
      description: 'Cancel a running background task by killing its process.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'Task ID from run_background_command.'
          }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_get_context',
      description: 'Read the database session the user is working in: engine, host, current database/schema/table, whether the connection is read-only or marked production, and whether its SQL editor is ready to receive text. Call this before any other db_* tool. Never executes anything.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active tab; if several database tabs are open and the active one is not a database tab, this must be passed.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_list_tables',
      description: 'List tables and views of a database on the user\'s open database session (read-only metadata query). Returns name plus kind (table/view) and, on PostgreSQL, the schema they belong to.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active database tab.'
          },
          database: {
            type: 'string',
            description: 'Database name. Omit to use the database currently selected in the session.'
          },
          limit: {
            type: 'number',
            description: 'Maximum entries to return (default 200, max 500). The total count is reported even when truncated.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_describe_table',
      description: 'Read one table\'s structure: columns (type, nullable, primary key, default, comment), indexes and foreign keys, plus a row estimate. Read-only metadata query; use it before writing SQL that depends on column names.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active database tab.'
          },
          table: {
            type: 'string',
            description: 'Table or view name to describe.'
          },
          database: {
            type: 'string',
            description: 'Database name. Omit to use the one currently selected.'
          },
          schema: {
            type: 'string',
            description: 'Schema name (PostgreSQL). Omit to use the one currently selected.'
          }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_read_result',
      description: 'Read the result set currently on the user\'s screen in that database session: the rows of the last SQL they ran, or the current page of the data grid when no query result is showing. Long cells are truncated and binary values are reported by size only. Does not run any SQL - if nothing is on screen it says so.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active database tab.'
          },
          resultIndex: {
            type: 'number',
            description: 'Which result set of the last run (multi-statement runs produce several). Default 0.'
          },
          offset: {
            type: 'number',
            description: 'Skip this many rows (default 0).'
          },
          limit: {
            type: 'number',
            description: 'Rows to return (default 20, max 50).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_insert_sql',
      description: 'Write SQL into the user\'s SQL editor at the cursor. It does NOT execute: the user reviews and runs it, and write/DDL statements still go through the app\'s danger confirmation. Use this instead of asking the user to copy-paste. If the editor is not ready (wrong tab, SQL panel closed) it fails and says why.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active database tab.'
          },
          sql: {
            type: 'string',
            description: 'The SQL text to place in the editor (one statement or several, no markdown fences).'
          }
        },
        required: ['sql']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redis_scan_keys',
      description: 'Sample keys in a Redis database on the user\'s open Redis session (read-only SCAN). Returns exact names with type and TTL where bounded; name:null with namePreview is not a usable key. COUNT is advisory: truncated batches omit items that nextCursor skips, so this is not an exhaustive enumeration. Never writes or removes keys. Requires a Redis tab; call db_get_context first.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Redis tab ID. Omit to use the active database tab.'
          },
          dbIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Redis database index (default 0).'
          },
          match: {
            type: 'string',
            description: 'Glob-style pattern to filter keys (default *).'
          },
          cursor: {
            type: 'string',
            description: 'Opaque SCAN cursor from a previous nextCursor; omit or "0" to start.'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Keys to return (default 50, max 200).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redis_get_key',
      description: 'Read one Redis key\'s type, TTL and bounded UTF-8 text preview (read-only, not binary-safe). Hash/set/stream cursors advance past the fetched batch, including any omitted items; check truncation before drawing conclusions. Lists/zsets are samples only. Never modifies the key. Requires a Redis tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Redis tab ID. Omit to use the active database tab.'
          },
          dbIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Redis database index (default 0).'
          },
          key: {
            type: 'string',
            maxLength: 8192,
            description: 'Exact key, including whitespace or an empty string. Never use a truncated namePreview as a key.'
          },
          cursor: {
            type: 'string',
            description: 'Opaque cursor for paging hash/set/stream contents; omit to start.'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Max fields/members/entries to return (default 50, max 200).'
          }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redis_info',
      description: 'Read the Redis server\'s INFO: a compact overview (version, mode, memory, clients, hit rate, ops/sec, total keys) plus per-db keyspace counts. Optionally include one raw section (e.g. memory, stats, commandstats). Read-only; requires a Redis tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Redis tab ID. Omit to use the active database tab.'
          },
          section: {
            type: 'string',
            description: 'Optional INFO section name to include (capped). Omit for overview only.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redis_slowlog',
      description: 'Read the Redis slow log: recent slow commands with duration, timestamp and a truncated argument preview (read-only SLOWLOG GET). Arguments are previewed, never full values. Requires a Redis tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Redis tab ID. Omit to use the active database tab.'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Entries to return (default 20, max 100).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_structure_diff',
      description: 'Compare two tables\' structure (columns, indexes, foreign keys) on the user\'s open SQL database session and report added/removed/changed items with field-level detail. Read-only metadata comparison: it does not generate or run any DDL. To propose changes, write ALTER text with db_insert_sql for the user to review. Requires a SQL (non-Redis) tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            description: 'Database tab ID. Omit to use the active database tab.'
          },
          baseTable: {
            type: 'string',
            description: 'The reference (base) table name.'
          },
          targetTable: {
            type: 'string',
            description: 'The table to compare against the base.'
          },
          baseDatabase: {
            type: 'string',
            description: 'Base table database. Omit to use the current one.'
          },
          baseSchema: {
            type: 'string',
            description: 'Base table schema (PostgreSQL). Omit to use the current one.'
          },
          targetDatabase: {
            type: 'string',
            description: 'Target table database. Omit to use the current one.'
          },
          targetSchema: {
            type: 'string',
            description: 'Target table schema (PostgreSQL). Omit to use the current one.'
          }
        },
        required: ['baseTable', 'targetTable']
      }
    }
  }
]

// M10 基线锚点：内置工具名清单（36 个，见设计 §1-S6）。`agentTools` 的顺序
// 与内容不许变；spec（mcp-builtin-tool-baseline.spec.js）拿它做快照与
// executeToolCall 的 case 覆盖检查，也作为 getToolSet 内置优先的冲突名单传入。
export const agentToolNames = agentTools.map(tool => tool && tool.function && tool.function.name)

/**
 * Execute one tool call.
 *
 * 路由（M24）：名字以 `mcp__` 开头 = 外部 MCP 工具别名，走
 * `store.mcpClientCallTool`（主进程做反查/校验/调用，**永不 throw**，失败也是
 * 结构化结果）；其余 36 个名字走内置 switch。外部分支必须在 switch 之前：
 * 内置名永远不含 `mcp__`（S7），不会被误分流。
 *
 * `opts`：`runId`（主进程按 run 取消挂起的调用，M30）、`timeoutMs`（per-call
 * 覆盖，M25 —— config-validate 把 server 级 timeoutMs 钳在 ≥5000，循环层的
 * 用例要更快收敛必须走这条覆盖）、`signal`（run 中止，M30）。
 * @param {string} toolName
 * @param {object} args
 * @param {{runId?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>} tool result text (always a string, like builtin tools)
 */
export async function executeToolCall (toolName, args, opts = {}) {
  if (isExternalAlias(toolName)) {
    const store = window.store
    const res = await store.mcpClientCallTool(toolName, args, {
      runId: (opts && opts.runId) || '',
      timeoutMs: opts && opts.timeoutMs,
      signal: opts && opts.signal
    })
    if (res && res.ok) {
      return typeof res.text === 'string' ? res.text : JSON.stringify(res.text)
    }
    const error = (res && res.error) || {
      code: 'mcp_internal_error',
      message: 'external tool call failed'
    }
    // M25：错误文案必须能让用户看出是哪台 server 出的问题。server 名取
    // 渲染层缓存的 meta.serverName（主进程校验过的 config.name）。
    const meta = (store.mcpExternalToolMeta && store.mcpExternalToolMeta[toolName]) || {}
    const serverName = meta.serverName || ''
    const message = error.message && serverName && !error.message.includes(serverName)
      ? `${error.message} (server "${serverName}")`
      : error.message
    return JSON.stringify({ error: { ...error, message } })
  }
  const store = window.store
  switch (toolName) {
    case 'send_terminal_command': {
      store.mcpSendTerminalCommand(args)
      const idleResult = await store.mcpWaitForTerminalIdle({
        tabId: args.tabId || store.activeTabId,
        timeout: 30000,
        lines: 100
      })
      return JSON.stringify(idleResult)
    }
    case 'get_terminal_output':
      return JSON.stringify(store.mcpGetTerminalOutput(args))
    case 'open_local_terminal':
      return JSON.stringify(store.mcpOpenLocalTerminal())
    case 'list_tabs':
      return JSON.stringify(store.mcpListTabs())
    case 'get_active_tab':
      return JSON.stringify(store.mcpGetActiveTab())
    case 'switch_tab':
      return JSON.stringify(store.mcpSwitchTab(args))
    case 'close_tab':
      return JSON.stringify(store.mcpCloseTab(args))
    case 'list_bookmarks':
      return JSON.stringify(store.mcpListBookmarks())
    case 'open_bookmark':
      return JSON.stringify(store.mcpOpenBookmark(args))
    case 'add_bookmark': {
      const { type } = args
      const typeFields = args[type] || {}
      return JSON.stringify(await store.mcpAddBookmark({ type, ...typeFields }))
    }
    case 'export_bookmarks':
      return JSON.stringify(store.mcpExportBookmarks(args))
    case 'open_tab': {
      const { type } = args
      const typeFields = args[type] || {}
      return JSON.stringify(store.mcpOpenTab({ type, ...typeFields }))
    }
    case 'sftp_list':
      return JSON.stringify(await store.mcpSftpList(args))
    case 'sftp_stat':
      return JSON.stringify(await store.mcpSftpStat(args))
    case 'sftp_read_file':
      return JSON.stringify(await store.mcpSftpReadFile(args))
    case 'sftp_del':
      return JSON.stringify(await store.mcpSftpDel(args))
    case 'sftp_upload':
      return JSON.stringify(await store.mcpSftpUpload(args))
    case 'sftp_download':
      return JSON.stringify(await store.mcpSftpDownload(args))
    case 'sftp_transfer_list':
      return JSON.stringify(store.mcpSftpTransferList())
    case 'sftp_transfer_history':
      return JSON.stringify(store.mcpSftpTransferHistory())
    case 'get_terminal_status':
      return JSON.stringify(store.mcpGetTerminalStatus(args))
    case 'cancel_terminal_command':
      return JSON.stringify(store.mcpCancelTerminalCommand(args))
    case 'set_terminal_keepalive':
      return JSON.stringify(store.mcpSetTerminalKeepalive(args))
    case 'run_background_command':
      return JSON.stringify(store.mcpRunBackgroundCommand(args))
    case 'get_background_task_status':
      return JSON.stringify(await store.mcpGetBackgroundTaskStatus(args))
    case 'get_background_task_log':
      return JSON.stringify(await store.mcpGetBackgroundTaskLog(args))
    case 'cancel_background_task':
      return JSON.stringify(await store.mcpCancelBackgroundTask(args))
    case 'db_get_context':
      return JSON.stringify(store.mcpDbGetContext(args))
    case 'db_list_tables':
      return JSON.stringify(await store.mcpDbListTables(args))
    case 'db_describe_table':
      return JSON.stringify(await store.mcpDbDescribeTable(args))
    case 'db_read_result':
      return JSON.stringify(store.mcpDbReadResult(args))
    case 'db_insert_sql':
      return JSON.stringify(store.mcpDbInsertSql(args))
    case 'redis_scan_keys':
      return JSON.stringify(await store.mcpRedisScanKeys(args))
    case 'redis_get_key':
      return JSON.stringify(await store.mcpRedisGetKey(args))
    case 'redis_info':
      return JSON.stringify(await store.mcpRedisInfo(args))
    case 'redis_slowlog':
      return JSON.stringify(await store.mcpRedisSlowlog(args))
    case 'db_structure_diff':
      return JSON.stringify(await store.mcpDbStructureDiff(args))
    default:
      throw new Error(`Unknown agent tool: ${toolName}`)
  }
}
