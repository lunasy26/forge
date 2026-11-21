**English** · [Русский](../ru/guards.md)

← [README](../../README.md)

# Guards

Two [`PreToolUse` hooks](hooks.md#hook-table) stop risky actions before they run: the command guard (for the Bash and PowerShell tools: the [Bash guard](#bash-guard) and the [PowerShell guard](#powershell-guard)) and the [file guard](#file-guard). Both work without a profile, with built-in defaults, on macOS, Linux and native Windows.

When an action is allowed, the guard hooks print nothing, and Claude Code's normal permissions apply. `deny` rejects the call and passes the reason to Claude; `ask` asks the user to confirm. Reasons start with `forge:` and come in the [message language](hooks.md#message-language); for example:

```
forge: git push --force is forbidden. For your own branch use --force-with-lease.
```

**On this page:**

- [Bash guard](#bash-guard)
  - [How a command is read](#how-a-command-is-read)
  - [Guard rules](#guard-rules)
  - [Abbreviated long options](#abbreviated-long-options)
  - [Recursive rm](#recursive-rm)
  - [Protected branches](#protected-branches)
- [PowerShell guard](#powershell-guard)
  - [How a PowerShell command is read](#how-a-powershell-command-is-read)
  - [PowerShell rules](#powershell-rules)
  - [What asks and why](#what-asks-and-why)
- [File guard](#file-guard)
  - [Pattern syntax](#pattern-syntax)
- [Limitations](#limitations)

## Bash guard

### How a command is read

This is not a full shell parser but a conservative split:

- the line is split into simple commands at `;`, `&&`, `||`, `|`, `&`, `(`, `)` and newlines; quotes are removed, comments and redirection targets don't count as arguments;
- before the command name, assignments (`FOO=1`), the wrappers `sudo`, `doas`, `env`, `command`, `exec`, `nohup`, `time`, `nice`, `builtin`, `timeout`, `xargs`, `stdbuf`, `ionice`, `chrt`, `taskset`, `watch` and the words `if`, `then`, `else`, `elif`, `while`, `until`, `do`, `{`, `}`, `!` are dropped. A wrapper is recognised by its normalised name (`/usr/bin/env`, `SUDO` and `env.exe` are all wrappers) and its options are skipped together with their values: `sudo -u root`, `nice -n 5`, `timeout -s KILL 10`, `env -u VAR`; a leading positional word is skipped too (`timeout`'s duration, `chrt`'s priority, `taskset`'s mask). The words `if`, `then` and the like count only when written exactly;
- the tables of wrapper options cannot cover every version, so there is a safety net: if a wrapper had an option the table does not know (`sudo --made-up value git push`) and the word left standing is not a guarded command, the check continues from the first later word that is one (`git`, `rm`, `eval`, a shell, `pwsh`, `powershell`, `cmd`). A false `ask` on `sudo --made-up echo git push` is better than a silent allow; without an unknown option nothing jumps, so `sudo echo git push` keeps `echo` as its command;
- `env -S 'string'` and `watch cmd…` hand a string to a shell; they are read as `sh -c` and the string is checked again;
- the command name is normalised: the last segment of the path (split on both `/` and `\`), lowercased, without `.exe`. So `/usr/bin/git`, `git.exe`, `GIT` and `C:\Git\cmd\git.exe` are all `git`. Only the exact name `cd` changes the directory (`/usr/bin/cd` and `CD` do not);
- `cd <dir>` changes the directory for the following commands on the same line (this matters for `rm -r` paths and for the current branch); `git -C <dir>` does it for that one command;
- the string after `bash`/`sh`/`zsh`/`dash`/`ksh` with the `-c` flag is checked as a separate command. `c` may sit in any cluster of short flags (`-lc`, `-xc`, `-cx`), `-o`/`-O` take a value (`-o pipefail`), so do `--rcfile`/`--init-file`, and `--` is skipped; the script is the first argument after the flags. The arguments of `eval` (without a leading `--`) are joined with spaces and checked the same way. `pwsh` and `powershell` (`-Command`) and `cmd /c` started from Bash are checked by the [PowerShell rules](#powershell-rules);
- commands inside the substitutions `$(…)`, `` `…` ``, `<(…)`, `>(…)` are checked the same way wherever the substitution stands: in double quotes, in `${x:-$(…)}`, inside `$((…))`, in a redirection target, in a heredoc body with an unquoted delimiter (`<<EOF`). The text of a heredoc body itself is not a command;
- text stays literal in single quotes, as `\$(…)` inside double quotes, and in heredoc bodies with a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`);
- `$'…'` is decoded (`\n`, `\t`, `\'`, `\\` and so on), so `$'git' push` is `git push`; `\x`, `\u`, `\U`, octal codes and `\c` are not decoded, and the word counts as runtime-dependent. Inside ordinary double quotes `$'` is plain text;
- `\` followed by a newline is joined where bash joins it: `"$\⏎(…)"` is `$(…)`. In single quotes, comments and heredoc bodies with a quoted delimiter, lines are not joined;
- a `<<` heredoc terminator does not strip leading tabs — only `<<-` does; with several heredocs on one line the bodies are read in turn. Inside `$(…)` a body also ends on an `EOF)` line, as in bash; a line that only starts with the delimiter (`EOFx`), or a terminator that bash 3.2 and bash 5 read differently, gives `ask`;
- `case`/`esac` inside `$(…)` are keywords only in command position (`$(grep -c case f)` doesn't confuse the parser), and inside `case`, after `in` and `;;`, come patterns: `(esac)` or `case)` there is a pattern, not a keyword. Command position also includes the positions after `name()`, `function NAME`, `time -p`, `coproc`; inside `((…))` heredocs, quotes and comments are not looked for, but `$(…)` substitutions in it are checked;
- nesting of `bash -c`, `eval` and substitutions is checked three levels deep; deeper gives `ask` (PowerShell nesting has [its own limit](#how-a-powershell-command-is-read), and the depth is shared when one shell starts the other). An unterminated substitution also gives `ask`;
- input the parser can't follow (nesting deeper than about 32 levels of `$(` or 64 of `${`, or more than about 40 steps per character) gives `ask`;
- if the guard itself fails with an error, the answer is `ask` (see [Fail-open and fail-closed](hooks.md#fail-open-and-fail-closed)).

The verdicts of all commands on the line are combined: `deny` beats `ask`, `ask` beats allow; the reasons of the winning level are joined. `git reset --hard && git push origin main` gets `deny`.

### Guard rules

| Command | Verdict | Details |
|---|---|---|
| `git push` to a branch from [`git.protected_branches`](#protected-branches) | deny | The target comes from the refspec: `main`, `HEAD:main`, `x:refs/heads/main`, `:main`, `--delete main`. `HEAD` and `@` mean the current branch. Without a refspec and without `--all` — the current branch. Forbidden with `--force-with-lease` too |
| `git push --force`, `-f` (also inside a flag cluster), `+refspec` | deny | Only `--force-with-lease` / `--force-if-includes` without `--force`, `-f` and `+refspec` is allowed, and only if the target isn't protected. `--force` cancels the lease check, so `--force --force-with-lease` is forbidden; `+refspec` is treated as `--force` (conservatively) |
| `git push --mirror` | deny | |
| `git push --no-verify` | deny | |
| `git commit --no-verify`, `-n` (also in a cluster: `-nm "…"`) | deny | In `git commit -m -n` the `-n` is the message text, which is allowed |
| `git push --all`, `--branches` | ask | Would push every local branch, protected ones included |
| `git reset --hard` | ask | |
| `rm -r`, `-R`, `--recursive` outside the project or on an unpredictable path | ask | See [Recursive rm](#recursive-rm); [PowerShell](#powershell-rules) has the same rule for `Remove-Item -Recurse` |
| `git push --dry-run`, `-n` | allowed | A dry run is not checked |

Order of the `git push` checks: `--mirror`, protected branch, force, `--no-verify`, `--all`; the first matching rule wins. git's global options before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`) are skipped.

A typical reason:

```
forge: pushing to the protected branch "main" is forbidden (git.protected_branches). Work in a separate branch and suggest a PR or a merge to the user.
```

### Abbreviated long options

git accepts any unambiguous prefix of a long option, so any prefix of a guarded option is read as that option: `--forc` and `--fo` are `--force`, `--no-verif` is `--no-verify`, `--mi` is `--mirror`, `--al` is `--all`, `--ha` is `--hard`. Guarded are `--force`, `--force-with-lease`, `--force-if-includes`, `--no-verify`, `--mirror`, `--all`, `--branches`, `--delete` for `push`, `--no-verify` for `commit`, `--hard` for `reset`. With an ambiguous prefix the first option of that list (the most dangerous one) wins. `--dry-run` must be spelled out in full: an abbreviation never turns a command into an allowed one.

### Recursive rm

A non-recursive `rm` is not checked. For every path of a recursive delete (`rm -r` here, [`Remove-Item -Recurse`](#powershell-rules) in PowerShell — the same rule):

- the path depends on runtime (`$VAR`, `$(…)`, backticks) — `ask`;
- the path is cut at the first `*`, `?` or `[` and resolved from the current directory (`build/*` → `build/`);
- a file system root (`/`, `C:\`, a UNC root `\\server\share\`), the home directory, the project root or one of its ancestors (`rm -rf .`, `rm -rf *` from the root) — `ask`;
- inside the project — allowed;
- inside the temp directories, but not the directory itself — allowed. On macOS and Linux these are `os.tmpdir()`, `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`; on Windows only `os.tmpdir()` (the user's `%TEMP%`);
- anything else (`../other`, `~/x`, `/etc`, `D:\data`) — `ask`.

On Windows paths are read as Windows paths, and the comparison ignores letter case (`c:\Project\Build` is inside `C:\project`). Besides `C:\x` and `C:/x`, `~\x` is the home directory. In Git Bash (the Bash tool on Windows) `/c/x` is `C:\x` (a single drive-letter segment) and `/tmp` is the temp directory; PowerShell has no such mounts, so there `/c/x` is `\c\x` on the current drive.

### Protected branches

Without a profile: `main` and `master`. The profile field [`git.protected_branches`](profile.md#profile-fields) **replaces** this list; `[]` removes branch protection. Patterns are anchored at both ends of the name: `*` doesn't cross `/`, `**` does. `release/*` protects `release/1.2` but not `release/1.2/hotfix`.

## PowerShell guard

The same hook `pre-bash.mjs` serves Claude Code's PowerShell tool (matcher `Bash|PowerShell`): for `tool_name: "PowerShell"` it applies the PowerShell reading of the same rules — protected pushes, force, `--no-verify`, `reset --hard` and a recursive delete — and for everything else the Bash rules above. Verdicts, silence on allow and fail-closed behaviour are the same as in the Bash guard.

### How a PowerShell command is read

Again a conservative split, not a PowerShell parser (`lib/pwsh.mjs`):

- the script is split into statements at `;`, newlines, `|`, `&&`, `||` and a background `&`; statements inside groups stay inside them. Quotes are removed (`'…'`, `"…"`, typographic quotes, here-strings `@'…'@` and `@"…"@`); comments (`#`, `<# … #>`) and redirection targets are not arguments. A backslash is not an escape (Windows paths stay intact); a backtick escapes the next character, and a backtick before a newline continues the line;
- a word whose value is known only at run time is dynamic: a variable (`$x`, `${x}`, `$env:X`), splatting (`@args`), `$(…)`, `@(…)`, `@{…}`, `(…)`, `{…}`, and `%VAR%` after `--%`. A variable assignment before a command (`$x = git push`, `$x += …`) is dropped, and the command is checked;
- the contents of every group, script block and `$(…)` (also inside a string) are checked again as a separate script wherever they are written, whether they run now or later, so `ForEach-Object { git push --force }` is caught;
- `&` and `.` (the call operator and dot-sourcing) make the next word the command name; if it is a variable or a group, the name is dynamic (see [What asks and why](#what-asks-and-why)). After `--%` the rest of the line up to a newline or `|` is split on whitespace;
- the command name is normalised as in Bash (`Git`, `git.exe`, `C:\Git\cmd\git.exe` are `git`), so names are case-insensitive. Parameters are read as PowerShell binds them: by the full name, an alias or an unambiguous prefix (`-Rec`, `-r`), case-insensitively; the value may be glued with a colon (`-Path:x`); `--` ends the parameters; an en or em dash counts as the parameter dash;
- `Set-Location` (`cd`, `sl`, `chdir`), `Push-Location` (`pushd`) and `Pop-Location` (`popd`) change the directory for the following statements, like `cd` in Bash. After a run-time path, no path, `-`, a path of another provider or a `popd` with an empty stack the directory is unknown, and relative delete targets then ask;
- a script that does not parse gets `ask`, not a pass: an unclosed quote, bracket, here-string or block comment, a closer without an opener, `&` or a redirection with nothing after it, a bare `<`, or input deeper or longer than the scanner follows. PowerShell parses the whole script before running it, so such a script either does not run or cannot be read statically;
- nesting of `Invoke-Expression`, `pwsh -Command`, groups and script blocks is checked eight levels deep (ordinary code nests blocks: a loop in an `if` in a `ForEach-Object`); deeper gives `ask`. The depth counter is shared with the Bash guard, so one shell starting the other cannot loop past the limit.

### PowerShell rules

| Command | Verdict | Details |
|---|---|---|
| `git …` | as in Bash | The same [rules](#guard-rules): protected branch, `--force`, `+refspec`, `--mirror`, `--no-verify`, `--all`, `reset --hard`; the name may be written `GIT` or `git.exe` |
| `Remove-Item`, `del`, `erase`, `ri`, `rd`, `rmdir` (`rm` too, on Windows) with `-Recurse` outside the project or on an unpredictable path | ask | The targets are `-Path`, `-LiteralPath` (`-PSPath`, `-LP`) or positional words; each goes through the [recursive delete rule](#recursive-rm). Any prefix of `-Recurse` counts; `-Recurse:$false`, `:0` and `:$null` turn it off. Without `-Recurse` the command is not checked. On macOS and Linux `rm` and `rmdir` are the system programs, so `rm -r` follows the Bash rule |
| `Remove-Item -Recurse` with no target (input from the pipeline) | ask | `Get-ChildItem … \| Remove-Item -Recurse`: it is unknown what will be deleted |
| `Remove-Item -Recurse` on another provider (`HKLM:\…`, `Registry::…`, `Env:`, `Cert:`) | ask | Any drive name longer than one letter; `FileSystem::C:\x` is a normal path |
| `Invoke-Expression`, `iex` with a literal string | as the string | The string is checked as PowerShell |
| `iex` with input from the pipeline or a run-time value (`iex $cmd`) | ask | Cannot be read |
| `pwsh`, `powershell` (also from Bash) with `-Command` / `-c` | as the string | The command (the rest of the line, or a first positional word) is checked as PowerShell; parameters match by prefix, case-insensitively, after `-`, `--` or `/` |
| `pwsh -EncodedCommand` (`-ec`), `-Command -`, a run-time `-Command` value | ask | The command is hidden in base64, comes from stdin or is only known at run time |
| `pwsh -File script.ps1` | allowed | Like running any script from Bash |
| `bash -c`, `sh -c`, `zsh`, `dash`, `ksh`, `eval` | as in Bash | The string is checked by the Bash rules |
| `cmd /c`, `/k` (and `//c` for Git Bash) that mentions `git`, `rm`, `bash`, `sh`, `zsh`, `wsl`, `pwsh`, `powershell`, `cmd` or `rd` / `rmdir` / `del` / `erase` with `/s` | ask | The guard does not read `cmd` syntax. Anything else (`cmd /c dir`) is allowed; a run-time argument asks |
| `Start-Process`, `saps`, `start` | as `& program args` | `-FilePath` (or the first positional word) and `-ArgumentList` (or the other positional words) are checked as a call, so `Start-Process git -ArgumentList push,--force` is denied like a forced push. Other programs pass; with a run-time argument a guarded program asks |
| a command whose name is a variable or a group (`& $exe …`) | ask only with dangerous arguments | See [What asks and why](#what-asks-and-why) |
| `Set-Alias`, `sal`, `New-Alias`, `nal` for a guarded command or a run-time value | ask | See [What asks and why](#what-asks-and-why) |
| `[scriptblock]::Create(…)`, `.InvokeCommand.InvokeScript(…)`, `.NewScriptBlock(…)`, `.AddScript(…)` anywhere in a statement | ask | A script built from a string at run time |

Verdicts of all statements are combined as in Bash: `deny` beats `ask`, `ask` beats allow.

### What asks and why

The principle is the opposite of "pass what you cannot read": PowerShell is parsed whole before it runs, so a script that does not parse, hides its code or builds it at run time gets `ask`. Typical reasons:

```
forge: Remove-Item -Recurse outside the project or on an unpredictable path: HKLM:\Software\X (not a file system path). Confirm.
forge: iex runs code known only at run time ($cmd) — cannot check it. Confirm.
forge: -EncodedCommand hides the command in base64 — cannot check it. Confirm.
```

The exception is the **dynamic command name**. `& $exe push origin main` could be anything, but variables holding tool paths are everyday PowerShell (`& $python script.py`, `& $msbuild /m`), and asking on all of them would teach you to click through. So such a call asks only when its arguments look dangerous: a word `push`, `reset` or `commit`, or a recursive-delete flag (`-r`, `-rec`, `--recursive`). The reason is `forge: the command name is only known at run time ($exe), and its arguments look like git push, reset, commit or a recursive delete. Confirm.`

`Set-Alias g git` would let a later `g push --force` slip past the name check, so an alias for a guarded command (`git`, `rm`, the shells, `pwsh`, `powershell`, `cmd`, `eval`, the delete family, `iex`, `Start-Process`, `Invoke-Command`) or for a run-time value asks: `forge: an alias for "git" would hide a guarded command from the check — call the command by its own name. Confirm.`

Known gaps of the PowerShell guard are in [Limitations](#limitations).

## File guard

A call to `Edit`, `Write`, `MultiEdit` or `NotebookEdit` for a path from `protected_files` is rejected (`deny`) with a reason. The path is taken relative to the project root (on Windows `\` is read as `/`); a file outside the project is matched by its absolute path, so `**/id_ed25519` also catches `~/.ssh/id_ed25519`. Matching ignores letter case on every OS, because the Windows and default macOS file systems treat `.ENV` and `.env` as one file: `.ENV`, `KEY.PEM` and `Id_RSA` are protected too, and the negations (`!.env.example`) ignore case the same way.

The built-in list always applies; [`protected_files`](profile.md#profile-fields) from the profile is appended after it:

```
.env  .env.*  .envrc  !.env.example  !.env.sample  !.env.template
**/*.pem  **/*.key  **/id_rsa  **/id_ed25519
```

### Pattern syntax

As in `.gitignore`: a pattern without `/` matches at any depth; a pattern with `/` is anchored to the root (except those starting with `**/`); `*` and `?` don't cross `/`, `**` does; `{a,b}` is an alternative; a directory pattern covers everything inside it; the last match wins; `!pattern` removes protection, including a built-in one (`"!.env"`). [`docs.watch`](agent-docs.md#what-counts-as-a-change) uses the same syntax.

## Limitations

- **The guards are a safety net against mistakes, not a sandbox.** They are not designed for a command that is deliberately hidden. [Not checked](#how-a-command-is-read):
  - a script fed to a shell through stdin: `… | bash`, `bash <<EOF`, `bash <<<'…'`, `bash -s`;
  - a command after a wrapper that is not on the list (`coproc …`, `setsid …`, `unshare …`) or after an unknown option of a listed one, unless a guarded command follows it later (see the safety net in [How a command is read](#how-a-command-is-read));
  - a target known only at runtime: `cd "$dir"`, `eval "$cmd"`, `bash -c "$script"`, `git push origin "$branch"`, a refspec with an undecodable `$'\x…'`;
  - a command whose name comes from a substitution: `$(true) git push --force origin main`, `${x:-}git push …`, `` `…`git push … ``, `$UNSET git push …`, `${x:-git push --force origin main}`. bash will run such commands, the guard lets them through. This is accepted for now: the guard protects against mistakes, not against evasion;
  - `source`/`.`, shell aliases and functions, `find -exec`, git aliases (`git -c alias.x='!…'`), scripts written to a file and run (`./deploy.sh`, `npm run …`), other interpreters (`python -c`, `node -e`), `ssh`;
  - input the parser can't follow (nesting deeper than about 32 levels of `$(` or 64 of `${`, or more than about 40 steps per character): it isn't checked in full, the command gets `ask`.
- **PowerShell.** The same "safety net, not a sandbox" principle. Not checked: .NET calls (`[IO.Directory]::Delete(…)`, `[IO.File]::Delete(…)`), `Invoke-Command -ScriptBlock $sb` and `& $sb` where the block is built elsewhere, functions, aliases and modules defined earlier (only `Set-Alias` to a guarded command is caught), scripts run from a file (`.\deploy.ps1`, `pwsh -File`), other interpreters, `Remove-Item` without `-Recurse`, other destructive cmdlets (`Clear-Content`, `Format-Volume`), and git aliases. A dynamic command name with harmless-looking arguments passes ([What asks and why](#what-asks-and-why)). Writes to protected files from a shell are not caught either, as in Bash.
- `git push` without a refspec is checked against the name of the current local branch. If the upstream points to a branch with a different name or `remote.<name>.push` defines its own refspecs, the guard doesn't see it ([Guard rules](#guard-rules)).
- `--no-verify` is caught only for `git commit` and `git push`. `git -c core.hooksPath=… commit`, `git merge --no-verify` and environment variables that disable hooks are not caught.
- Other destructive commands are not guarded: `git clean`, `git checkout -- .`, `git restore`, `git branch -D`, `find -delete`, non-recursive `rm`.
- The [file guard](#file-guard) fires only on edit tools. Reading `.env` is not blocked; writing through Bash (`echo … > .env`, `sed -i`) is not caught.
