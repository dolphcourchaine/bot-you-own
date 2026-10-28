#!/usr/bin/env python3
"""
Offline eval of Plate's "which way is up" second opinion (Engine/worker/track-orient.js, Clef).

It runs the SAME code the live orient route runs, through a local worker:

    npx wrangler dev --var ORIENT_EVAL:1 --port 8799        # (Workers AI calls go to Cloudflare; ~$0.00015 a look)
    python3 Engine/tests/orient-eval.py --upright ~/plate-eval/upright --no-top ~/plate-eval/no-top --url http://127.0.0.1:8799

The test set (two folders of photos; EXIF is applied first, so phone photos are fine as they are):
  --upright   photos that are the right way up and HAVE a top (a can, a label, a receipt, a scale, a plate shot
              at an angle). Each is sent at 0, 90, 180 and 270 degrees clockwise; the right answer turns it back.
  --no-top    hard negatives: food seen straight from above, anything with no clear top. Sent all four ways;
              the right answer is always "leave it" (a turn there is harmless but counts as noise).

Each photo is shrunk like the page does (512 px on the long side, aspect kept, JPEG 0.7); a landscape one also goes
with a copy turned 90 degrees clockwise, as the page sends it. Every photo the step turns is sent again, turned:
the second answer must be 0 (idempotent).

The numbers that matter, reported apart:
  UPRIGHT WRONGLY TURNED   upright photos (0 degrees) the step would turn. Must be 0.
  made worse               turned photos given a wrong turn.
  fixed / left alone       turned photos put right / not touched.
Needs Pillow (pip install pillow). Results: Engine/tests/results/orient-eval-<date>.json (+ .md). The photos never
leave this machine except to the local worker (and from it to Workers AI); keep owner photos out of git.
"""
import argparse, io, json, os, sys, time, uuid, urllib.request, datetime, statistics
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageOps, ImageDraw

EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36"


def load(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)          # lesson 1: EXIF first, then judge the pixels
    return im.convert("RGB")


def turned(im, deg):
    """deg clockwise. PIL rotates counter-clockwise, hence the minus."""
    return im if deg % 360 == 0 else im.rotate(-deg, expand=True)


def small(im, size):
    k = min(1.0, size / max(im.width, im.height))
    return im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS) if k < 1 else im.copy()


def jpeg(im, q=70):
    b = io.BytesIO(); im.save(b, "JPEG", quality=q); return b.getvalue()


def landscape(im):
    return im.width > im.height * 1.02           # the same test as track-orient.js shapeOf and the page


def post(url, im, model):
    parts = [("photo", "p.jpg", jpeg(im))]
    if landscape(im):
        parts.append(("cw", "cw.jpg", jpeg(turned(im, 90))))
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    for name, fn, data in parts:
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{fn}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()); body.write(data); body.write(b"\r\n")
    body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n--{boundary}--\r\n'.encode())
    req = urllib.request.Request(url, data=body.getvalue(), method="POST", headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": UA})
    t0 = time.time()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.load(r); out["wall_ms"] = round((time.time() - t0) * 1000); return out
        except Exception as e:  # a dropped connection to the local worker: try again, then report it
            err = str(e); time.sleep(2 * (attempt + 1))
    return {"ok": False, "error": err, "turn": None, "verdict": "request-failed"}


def run_case(args, case):
    im = small(turned(case["image"], case["rot"]), args.size)
    r = post(args.endpoint, im, args.model)
    out = {k: case[k] for k in ("file", "set", "rot", "expect")}
    out.update({"shape": "landscape" if landscape(im) else "portrait", "turn": r.get("turn"), "verdict": r.get("verdict"),
                "probs": [l.get("p") for l in r.get("looks", [])], "asked": [l.get("asked") for l in r.get("looks", [])],
                "ms": sum(l.get("ms", 0) for l in r.get("looks", [])), "wall_ms": r.get("wall_ms"), "tokens": r.get("tokens", 0),
                "cost_usd": r.get("cost_usd", 0), "error": r.get("error")})
    # Idempotent: whatever it turned, turned that way and asked again, must come back 0.
    if isinstance(out["turn"], int) and out["turn"]:
        r2 = post(args.endpoint, turned(im, out["turn"]), args.model)
        out.update({"again_turn": r2.get("turn"), "again_verdict": r2.get("verdict"), "tokens": out["tokens"] + r2.get("tokens", 0), "cost_usd": out["cost_usd"] + r2.get("cost_usd", 0)})
    return out


def classify(c):
    if c["turn"] is None:
        return "error"
    if c["set"] == "no-top":
        return "no-top acted on" if c["turn"] else "no-top left alone"
    if c["rot"] == 0:
        return "UPRIGHT WRONGLY TURNED" if c["turn"] else "upright left alone"
    if c["turn"] == c["expect"]:
        return "fixed"
    return "left alone (was turned)" if c["turn"] == 0 else "made worse"


def check_sheet(args, uprights, path):
    """Lesson 10: look at the rotated copies by eye before trusting the labels. One photo, four turns, with the expected answer."""
    if not uprights:
        return
    im = small(uprights[0][1], 220)
    S = Image.new("RGB", (4 * 240, 260), "white"); d = ImageDraw.Draw(S)
    for k, rot in enumerate((0, 90, 180, 270)):
        t = turned(im, rot); S.paste(t, (k * 240 + (240 - t.width) // 2, 0))
        d.text((k * 240 + 6, 240), f"sent {rot} cw -> expect turn {(360 - rot) % 360}", fill="red")
    S.save(path, quality=85)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upright", required=True); ap.add_argument("--no-top")
    ap.add_argument("--url", default="http://127.0.0.1:8799"); ap.add_argument("--api", default="/api/food/")
    ap.add_argument("--model", default="clef", choices=["clef", "clef-flash"]); ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--jobs", type=int, default=4); ap.add_argument("--out", default="")
    args = ap.parse_args()
    args.endpoint = args.url.rstrip("/") + args.api + "orient-eval"

    def folder(d):
        return sorted(os.path.join(d, f) for f in os.listdir(os.path.expanduser(d)) if f.lower().endswith(EXTS)) if d else []
    uprights = [(p, load(p)) for p in folder(os.path.expanduser(args.upright))]
    notop = [(p, load(p)) for p in folder(os.path.expanduser(args.no_top))] if args.no_top else []
    cases = [{"file": os.path.basename(p), "set": "upright", "rot": rot, "expect": (360 - rot) % 360, "image": im} for p, im in uprights for rot in (0, 90, 180, 270)]
    cases += [{"file": os.path.basename(p), "set": "no-top", "rot": rot, "expect": 0, "image": im} for p, im in notop for rot in (0, 90, 180, 270)]
    print(f"{len(uprights)} upright + {len(notop)} no-top photos -> {len(cases)} cases, model {args.model}, {args.size} px, via {args.endpoint}", flush=True)

    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", f"orient-eval-{args.model}-{stamp}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    check_sheet(args, uprights, out + "-check.jpg")

    done = []
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for k, r in enumerate(ex.map(lambda c: run_case(args, c), cases)):
            r["outcome"] = classify(r); done.append(r)
            if (k + 1) % 20 == 0: print(f"  {k + 1}/{len(cases)}", flush=True)

    tally = {}
    for r in done: tally[r["outcome"]] = tally.get(r["outcome"], 0) + 1
    by_shape = {}
    for r in done:
        if r["set"] == "upright" and r["rot"]:
            s = by_shape.setdefault(f'{r["shape"]} (sent turned)', {"cases": 0, "fixed": 0, "left": 0, "worse": 0})
            s["cases"] += 1; s["fixed"] += r["outcome"] == "fixed"; s["left"] += r["outcome"] == "left alone (was turned)"; s["worse"] += r["outcome"] == "made worse"
    not_idem = [r for r in done if r.get("again_turn")]
    ms = [r["ms"] for r in done if r["ms"]]
    spend = sum(r["cost_usd"] or 0 for r in done)
    summary = {
        "when": stamp, "model": args.model, "size": args.size, "cases": len(done), "outcomes": tally, "by_shape": by_shape,
        "upright_wrongly_turned": tally.get("UPRIGHT WRONGLY TURNED", 0), "not_idempotent": len(not_idem),
        "latency_ms": {"p50": statistics.median(ms) if ms else None, "p95": sorted(ms)[int(0.95 * (len(ms) - 1))] if ms else None},
        "tokens": sum(r["tokens"] or 0 for r in done), "spend_usd": round(spend, 5),
    }
    json.dump({"summary": summary, "cases": done}, open(out + ".json", "w"), indent=1)

    lines = [f"# Orientation eval — {args.model}, {stamp}", "", f"{len(uprights)} upright photos × 4 turns, {len(notop)} no-top photos × 4 turns = {len(done)} cases.", "",
             f"- **Upright photos wrongly turned: {summary['upright_wrongly_turned']}** (must be 0)",
             f"- Turned photos fixed: {tally.get('fixed', 0)} · left alone: {tally.get('left alone (was turned)', 0)} · made worse: {tally.get('made worse', 0)}",
             f"- No-top photos acted on: {tally.get('no-top acted on', 0)} of {4 * len(notop)}",
             f"- Not idempotent (turned, then turned again): {len(not_idem)}",
             f"- Errors: {tally.get('error', 0)}",
             f"- Latency (model time per photo): p50 {summary['latency_ms']['p50']} ms, p95 {summary['latency_ms']['p95']} ms",
             f"- Spend: ${spend:.4f} for {summary['tokens']} input tokens", "", "| shape | cases | fixed | left alone | made worse |", "|---|---|---|---|---|"]
    lines += [f"| {k} | {v['cases']} | {v['fixed']} | {v['left']} | {v['worse']} |" for k, v in by_shape.items()]
    bad = [r for r in done if r["outcome"] in ("UPRIGHT WRONGLY TURNED", "made worse", "no-top acted on", "error")] + not_idem
    if bad:
        lines += ["", "## To look at", "", "| file | set | sent | expected | got | verdict | probabilities | again |", "|---|---|---|---|---|---|---|---|"]
        for r in bad:
            pr = "; ".join(", ".join(f"{k} {v:.2f}" for k, v in sorted(p.items(), key=lambda x: -x[1])[:2]) for p in r["probs"] if p)
            lines.append(f"| {r['file']} | {r['set']} | {r['rot']} | {r['expect']} | {r['turn']} | {r['verdict']} | {pr} | {r.get('again_turn', '')} |")
    open(out + ".md", "w").write("\n".join(lines) + "\n")
    print("\n".join(lines)); print(f"\nWritten: {out}.json, {out}.md, {out}-check.jpg")
    return 1 if summary["upright_wrongly_turned"] else 0


if __name__ == "__main__":
    sys.exit(main())
