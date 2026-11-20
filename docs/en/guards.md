**English** · [Русский](../ru/guards.md)

← [README](../../README.md)

# Guards

Two [`PreToolUse` hooks](hooks.md#hook-table) stop risky actions before they run: the Bash guard and the file guard. Both work without a profile, with built-in defaults.

When an action is allowed, the guard hooks print nothing, and Claude Code's normal permissions apply. `deny` rejects the call and passes the reason to Claude; `ask` asks the user to confirm. Reasons are in Russian and start with `forge:`, for example:

```
forge: git push --force запрещён. Для своей ветки используй --force-with-lease.
```

("git push --force is forbidden. For your own branch use --force-with-lease.")

**On this page:**

- [Bash guard](#bash-guard)
  - [How a command is read](#how-a-command-is-read)
  - [Guard rules](#guard-rules)
  - [Abbreviated long options](#abbreviated-long-options)
  - [Recursive rm](#recursive-rm)
  - [Protected branches](#protected-branches)
- [File guard](#file-guard)
  - [Pattern syntax](#pattern-syntax)
- [Limitations](#limitations)

## Bash guard

### How a command is read

This is not a full shell parser but a conservative split:

- the line is split into simple commands at `;`, `&&`, `||`, `|`, `&`, `(`, `)` and newlines; quotes are removed, comments and redirection targets don't count as arguments;
- before the command name, assignments (`FOO=1`), the wrappers `sudo`, `env`, `command`, `exec`, `nohup`, `time`, `nice`, `builtin` with their `-…` flags, and the words `if`, `then`, `else`, `elif`, `while`, `until`, `do`, `{`, `}`, `!` are dropped; the name is compared by basename (`/usr/bin/git` is `git`);
- `cd <dir>` changes the directory for the following commands on the same line (this matters for `rm -r` paths and for the current branch); `git -C <dir>` does it for that one command;
- the string after `bash`/`sh`/`zsh`/`dash`/`ksh` with the `-c` flag is checked as a separate command. `c` may sit in any cluster of short flags (`-lc`, `-xc`, `-cx`), `-o`/`-O` take a value (`-o pipefail`), so do `--rcfile`/`--init-file`, and `--` is skipped; the script is the first argument after the flags. The arguments of `eval` (without a leading `--`) are joined with spaces and checked the same way;
- commands inside the substitutions `$(…)`, `` `…` ``, `<(…)`, `>(…)` are checked the same way wherever the substitution stands: in double quotes, in `${x:-$(…)}`, inside `$((…))`, in a redirection target, in a heredoc body with an unquoted delimiter (`<<EOF`). The text of a heredoc body itself is not a command;
- text stays literal in single quotes, as `\$(…)` inside double quotes, and in heredoc bodies with a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`);
- `$'…'` is decoded (`\n`, `\t`, `\'`, `\\` and so on), so `$'git' push` is `git push`; `\x`, `\u`, `\U`, octal codes and `\c` are not decoded, and the word counts as runtime-dependent. Inside ordinary double quotes `$'` is plain text;
- `\` followed by a newline is joined where bash joins it: `"$\⏎(…)"` is `$(…)`. In single quotes, comments and heredoc bodies with a quoted delimiter, lines are not joined;
- a `<<` heredoc terminator does not strip leading tabs — only `<<-` does; with several heredocs on one line the bodies are read in turn. Inside `$(…)` a body also ends on an `EOF)` line, as in bash; a line that only starts with the delimiter (`EOFx`), or a terminator that bash 3.2 and bash 5 read differently, gives `ask`;
- `case`/`esac` inside `$(…)` are keywords only in command position (`$(grep -c case f)` doesn't confuse the parser), and inside `case`, after `in` and `;;`, come patterns: `(esac)` or `case)` there is a pattern, not a keyword. Command position also includes the positions after `name()`, `function NAME`, `time -p`, `coproc`; inside `((…))` heredocs, quotes and comments are not looked for, but `$(…)` substitutions in it are checked;
- nesting of `bash -c`, `eval` and substitutions is checked three levels deep; deeper gives `ask`. An unterminated substitution also gives `ask`;
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
| `rm -r`, `-R`, `--recursive` outside the project or on an unpredictable path | ask | See [Recursive rm](#recursive-rm) |
| `git push --dry-run`, `-n` | allowed | A dry run is not checked |

Order of the `git push` checks: `--mirror`, protected branch, force, `--no-verify`, `--all`; the first matching rule wins. git's global options before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`) are skipped.

A typical reason:

```
forge: push в защищённую ветку «main» запрещён (git.protected_branches). Работай в отдельной ветке и предложи пользователю PR или слияние.
```

("push to the protected branch «main» is forbidden (git.protected_branches). Work in a separate branch and offer the user a PR or a merge.")

### Abbreviated long options

git accepts any unambiguous prefix of a long option, so any prefix of a guarded option is read as that option: `--forc` and `--fo` are `--force`, `--no-verif` is `--no-verify`, `--mi` is `--mirror`, `--al` is `--all`, `--ha` is `--hard`. Guarded are `--force`, `--force-with-lease`, `--force-if-includes`, `--no-verify`, `--mirror`, `--all`, `--branches`, `--delete` for `push`, `--no-verify` for `commit`, `--hard` for `reset`. With an ambiguous prefix the first option of that list (the most dangerous one) wins. `--dry-run` must be spelled out in full: an abbreviation never turns a command into an allowed one.

### Recursive rm

A non-recursive `rm` is not checked. For every path of a recursive delete:

- the path depends on runtime (`$VAR`, `$(…)`, backticks) — `ask`;
- the path is cut at the first `*`, `?` or `[` and resolved from the current directory (`build/*` → `build/`);
- `/`, the home directory, the project root or one of its ancestors (`rm -rf .`, `rm -rf *` from the root) — `ask`;
- inside the project — allowed;
- inside the temp directories (`os.tmpdir()`, `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`), but not the directory itself — allowed;
- anything else (`../other`, `~/x`, `/etc`) — `ask`.

### Protected branches

Without a profile: `main` and `master`. The profile field [`git.protected_branches`](profile.md#profile-fields) **replaces** this list; `[]` removes branch protection. Patterns are anchored at both ends of the name: `*` doesn't cross `/`, `**` does. `release/*` protects `release/1.2` but not `release/1.2/hotfix`.

## File guard

A call to `Edit`, `Write`, `MultiEdit` or `NotebookEdit` for a path from `protected_files` is rejected (`deny`) with a reason. The path is taken relative to the project root; a file outside the project is matched by its absolute path, so `**/id_ed25519` also catches `~/.ssh/id_ed25519`.

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
  - a command after a wrapper with a separate flag value or a wrapper not on the list: `sudo -u user …`, `nice -n 5 …`, `timeout 5 …`, `xargs …`, `coproc …`;
  - a target known only at runtime: `cd "$dir"`, `eval "$cmd"`, `bash -c "$script"`, `git push origin "$branch"`, a refspec with an undecodable `$'\x…'`;
  - a command whose name comes from a substitution: `$(true) git push --force origin main`, `${x:-}git push …`, `` `…`git push … ``, `$UNSET git push …`, `${x:-git push --force origin main}`. bash will run such commands, the guard lets them through. This is accepted for now: the guard protects against mistakes, not against evasion;
  - `source`/`.`, shell aliases and functions, `find -exec`, git aliases (`git -c alias.x='!…'`), scripts written to a file and run (`./deploy.sh`, `npm run …`), other interpreters (`python -c`, `node -e`), `ssh`;
  - input the parser can't follow (nesting deeper than about 32 levels of `$(` or 64 of `${`, or more than about 40 steps per character): it isn't checked in full, the command gets `ask`.
- `git push` without a refspec is checked against the name of the current local branch. If the upstream points to a branch with a different name or `remote.<name>.push` defines its own refspecs, the guard doesn't see it ([Guard rules](#guard-rules)).
- `--no-verify` is caught only for `git commit` and `git push`. `git -c core.hooksPath=… commit`, `git merge --no-verify` and environment variables that disable hooks are not caught.
- Other destructive commands are not guarded: `git clean`, `git checkout -- .`, `git restore`, `git branch -D`, `find -delete`, non-recursive `rm`.
- The [file guard](#file-guard) fires only on edit tools. Reading `.env` is not blocked; writing through Bash (`echo … > .env`, `sed -i`) is not caught.
