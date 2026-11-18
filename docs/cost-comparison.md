# How the cost comparison works

The run details page shows two figures for every finished run: what the run cost on your infrastructure, and an estimate of what the same run would cost on Apify. This page explains how each is computed, what each leaves out, and how to work out whether self-hosting pays for itself in your case.

The comparison is a model, not an invoice. It never claims a guaranteed saving, and you should not either without putting your own numbers in.

## Your cost

A runner machine bills a flat hourly price however many actor containers it hosts. A run's cost is its share of that price:

1. Take the run's own time window on the runner.
2. Slice it at every moment another run started or finished on the same runner.
3. For each slice, charge `runner price per hour × slice hours ÷ runs active in that slice`.
4. Add the slices up.

Summed over every run on a runner, this reconciles with what the provider billed for the time the runner was busy. The price and the runner identity are stamped on the run when a runner claims it, so later price changes do not rewrite history.

Three cases:

| Run executed on                                         | Figure shown                                      |
| ------------------------------------------------------- | ------------------------------------------------- |
| A runner provisioned by the autoscaler (price recorded) | The overlap share described above                 |
| Local Docker or a runner with no recorded price         | `$0`, labelled self-hosted: no price was recorded |
| A run from before cost stamps existed                   | "Not recorded"                                    |

A `$0` self-hosted figure means "no runner price is known", not "this was free". The machine it ran on still costs something.

## The Apify estimate

```text
compute units = memory in GB × run duration in hours
Apify estimate = compute units × APIFY_CU_PRICE
```

`APIFY_CU_PRICE` defaults to `0.20`, Apify's listed rate for the Free and Starter plans when this page was written (November 2026). Scale was `0.16` and Business `0.13`. Apify changes these, so check [their pricing page](https://apify.com/pricing) and set the variable to the plan you would otherwise be on. The run details page prints the rate it used.

## What each side leaves out

| Left out of your cost                                  | Left out of the Apify estimate                   |
| ------------------------------------------------------ | ------------------------------------------------ |
| Idle runner time (a runner waiting for work bills too) | Proxy usage                                      |
| Postgres, Redis, object storage and the API host       | Storage and data transfer                        |
| Your time: upgrades, monitoring, being on call         | The monthly plan fee and its prepaid usage rules |
| Your own proxy provider, if you use one                | Pay-per-result or rental fees of Store actors    |

Each column understates its side. Which one understates more depends on your workload: steady, memory-heavy runs favour a flat-priced runner; short, bursty runs leave a self-hosted runner idle most of the time.

## Working out your break-even

Use a month of your own numbers.

```text
apify_monthly      = compute units per month × your Apify CU rate
                     + proxy, storage and transfer you would pay Apify

selfhosted_monthly = runner hours per month × runner price per hour   (busy AND idle)
                     + database, cache, storage and API host
                     + proxy you pay elsewhere
                     + hours of upkeep per month × what an hour of your time is worth

self-hosting pays when selfhosted_monthly < apify_monthly
```

A worked example with round numbers, to show the shape rather than to predict your bill:

- 2,000 compute units a month at `$0.16` is `$320` on Apify, before proxy and storage.
- One 8 GB runner at `$0.071` an hour, left on all month (730 hours), is about `$52`. Add `$45` for a small managed Postgres, Redis and object storage: about `$97`.
- That leaves about `$223` a month. If keeping the stack healthy takes you three hours a month, self-hosting pays as long as an hour of your time is worth less than about `$74` here. At ten hours a month the threshold drops to about `$22`.

If the last line does not come out in your favour, Apify Cloud is the better choice, and that is a fine answer.

## Sharing a run's numbers

The **Copy** button on the Cost Analysis card puts a markdown summary on your clipboard: both figures, the item count, duration and compute units, and the caveats above in short form. It states no savings percentage, and for a run on a runner with no recorded price it says so rather than reporting a saving. The card itself shows no "You saved" figure for such a run either.

## Reference

- Endpoint: `GET /v2/actor-runs/:runId/cost` returns both figures and an `inputs` object with everything that went into them (runner provider and price, overlapping runs, CU rate, compute units, duration).
- Attribution logic: `packages/api/src/lib/run-cost.ts`.
