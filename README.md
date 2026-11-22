# fast-site-builder

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hmnk0311/fast-site-builder/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hmnk0311/fast-site-builder/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: `solve.js` exports
`run(input)`, which returns makefun-site's exact answer (the whole
output tree: every page's index.html, the index and tag pages,
build-report.txt and each static file) for every site input, byte for
byte — front matter refusals, slug collisions, broken links, the
Markdown subset and the template dialect all read exactly as the
reference reads them.

makefun-site renders its Markdown one character at a time, escapes
each character on its own, re-normalises every repeated slug and
builds an array of every word just to count them. This build does the
same work in bulk: plain text is escaped in runs, slug and long-date
results are memoised per build, the inline parser takes native
indexOf fast paths when no backslash is in play, word counting is a
single scan, and templates are compiled once and rendered into a
shared buffer over a scope chain instead of a fresh merged vars
object per page.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<dir holding cases.json> MAKEFUN_OUTPUT_DIR=out node main.ts
cat out/answers.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
