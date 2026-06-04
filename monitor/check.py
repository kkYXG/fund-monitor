#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基金「可申购」监控脚本（云端，GitHub Actions 每 6 小时运行）

职责：
  1. 读取仓库根目录 watchlist.json 中的基金代码清单；
  2. 逐只查询东方财富 FundMNBasicInformation 接口，取申购状态 SGZT；
  3. 与上次状态 state.json 比对，挑出「本次新变为可买」的基金；
  4. 若有，发邮件到指定邮箱提醒（名称 + 代码 + 状态）；
  5. 回写 state.json（供下次去重，避免重复提醒）。

判定规则（与前端 js/watch.js 一致）：申购状态文本不含
  「暂停 / 封闭 / 停止 / 未开放 / 终止」即视为「能买」（开放申购、限大额都算）。

凭据全部从环境变量读取，绝不硬编码：
  MAIL_USER  发件邮箱（= 收件邮箱，网易企业邮箱）
  MAIL_PASS  邮箱密码 / 客户端授权码（存 GitHub Secrets）
  MAIL_TO    收件邮箱（默认同 MAIL_USER）
  SMTP_HOST  默认 smtp.qiye.163.com
  SMTP_PORT  默认 465（SSL）

@author funds-web
"""

import json
import os
import smtplib
import ssl
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

# 路径：脚本在 monitor/ 下，watchlist.json 在仓库根，state.json 与脚本同级
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WATCHLIST_PATH = os.path.join(ROOT, "watchlist.json")
STATE_PATH = os.path.join(HERE, "state.json")

# 「不可买」关键词，命中任一即视为当前买不了（与前端保持一致）
BLOCK_KEYWORDS = ["暂停", "封闭", "停止", "未开放", "终止"]

BASIC_INFO_API = (
    "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation"
    "?plat=Android&appType=ttjj&product=EFund&Version=1"
    "&deviceid=fundsweb000000000000000000000000&FCODE={code}"
)


def cn_now():
    """返回北京时间字符串，便于日志/邮件阅读。"""
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:  # 文件损坏不致整个任务失败
        print("读取 %s 失败：%s" % (path, e), file=sys.stderr)
        return default


def read_codes():
    """从 watchlist.json 读取代码清单，兼容 {codes:[...]} 或纯数组两种格式。"""
    data = load_json(WATCHLIST_PATH, {"codes": []})
    if isinstance(data, list):
        codes = data
    else:
        codes = data.get("codes", [])
    # 去重 + 仅保留 6 位数字
    seen, out = set(), []
    for c in codes:
        c = str(c).strip()
        if c.isdigit() and len(c) == 6 and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def is_buyable(sgzt):
    if not sgzt:
        return False
    return not any(k in sgzt for k in BLOCK_KEYWORDS)


def fetch_status(code):
    """查询单只基金申购状态，返回 {code,name,sgzt,buyable} 或 None。"""
    url = BASIC_INFO_API.format(code=code)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "fund-monitor/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        d = data.get("Datas")
        if not d or not d.get("FCODE"):
            return None
        sgzt = d.get("SGZT") or ""
        return {
            "code": d.get("FCODE"),
            "name": d.get("SHORTNAME") or "",
            "sgzt": sgzt,
            "sgztMark": d.get("SGZTMARK") or "",
            "buyable": is_buyable(sgzt),
        }
    except Exception as e:
        print("查询 %s 失败：%s" % (code, e), file=sys.stderr)
        return None


def _smtp_send(subject, body):
    """统一的发信底层：网易企业邮箱 SSL。凭据来自环境变量。"""
    user = os.environ.get("MAIL_USER", "").strip()
    password = os.environ.get("MAIL_PASS", "").strip()
    to_addr = os.environ.get("MAIL_TO", "").strip() or user
    # 用 `or` 而非 get 的默认值：工作流传入的空字符串("")也要回退到默认，
    # 否则 int("") 会崩、host 会变空（这正是 vars.SMTP_PORT 未设置时的情况）。
    host = (os.environ.get("SMTP_HOST") or "smtp.qiye.163.com").strip()
    port = int(os.environ.get("SMTP_PORT") or "465")

    if not user or not password:
        print("缺少 MAIL_USER / MAIL_PASS，跳过发信", file=sys.stderr)
        return False

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((str(Header("基金监控", "utf-8")), user))
    msg["To"] = to_addr

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as server:
        server.login(user, password)
        server.sendmail(user, [to_addr], msg.as_string())
    print("已发送邮件至 %s：%s" % (to_addr, subject))
    return True


def send_mail(newly_buyable):
    """发送「变为可买」提醒邮件（监控跳变时）。newly_buyable: [{code,name,sgzt,...}]。"""
    lines = ["以下基金已变为「可申购」，请及时操作：", ""]
    for f in newly_buyable:
        mark = ("（%s）" % f["sgztMark"]) if f.get("sgztMark") else ""
        lines.append("· %s  [%s]  状态：%s%s" % (f["name"], f["code"], f["sgzt"], mark))
    lines += ["", "—— 自动监控于 %s（北京时间）" % cn_now()]
    return _smtp_send(
        "【基金可买提醒】%d 只基金现可申购" % len(newly_buyable), "\n".join(lines)
    )


def notify_status(code):
    """
    立即查询单只基金当前申购状态并发邮件（用户在网页新增监控时即时告知是否可买）。
    无论可买与否都发，区别于 send_mail 的「仅跳变时发」。
    """
    s = fetch_status(code)
    if not s:
        _smtp_send(
            "【基金状态查询】%s 查询失败" % code,
            "无法获取基金 %s 的申购状态，请稍后在网页查看。\n\n—— %s（北京时间）"
            % (code, cn_now()),
        )
        return
    buyable = s["buyable"]
    mark = ("（%s）" % s["sgztMark"]) if s.get("sgztMark") else ""
    body = "\n".join(
        [
            "你新增监控的基金，当前状态如下：",
            "",
            "· %s  [%s]" % (s["name"], s["code"]),
            "  是否可买：%s" % ("可以购买 ✓" if buyable else "暂不可购买 ✕"),
            "  申购状态：%s%s" % (s["sgzt"], mark),
            "",
            "若暂不可买，系统将每 6 小时持续监控，变为可买时再次提醒。",
            "",
            "—— 查询于 %s（北京时间）" % cn_now(),
        ]
    )
    subject = "【基金状态】%s %s" % (s["name"], "现在可买" if buyable else "暂不可买")
    _smtp_send(subject, body)


def main():
    # 即时查询：网页新增监控时通过 workflow_dispatch 传入 NOTIFY_CODE，
    # 立即查该基金当前状态并发邮件（不等 6 小时定时轮询）。
    notify_code = os.environ.get("NOTIFY_CODE", "").strip()
    if notify_code and notify_code.isdigit() and len(notify_code) == 6:
        print("[%s] 即时查询 %s 并邮件告知" % (cn_now(), notify_code))
        try:
            notify_status(notify_code)
        except Exception as e:
            print("即时通知失败：%s" % e, file=sys.stderr)

    codes = read_codes()
    if not codes:
        print("watchlist.json 无监控代码，结束。")
        return

    prev = load_json(STATE_PATH, {}).get("status", {})  # {code: {buyable, sgzt, name}}
    print("[%s] 开始监控 %d 只：%s" % (cn_now(), len(codes), ",".join(codes)))

    cur = {}
    newly_buyable = []
    for code in codes:
        s = fetch_status(code)
        if not s:
            # 查询失败：沿用上次状态，避免误判/丢状态
            if code in prev:
                cur[code] = prev[code]
            continue
        cur[code] = {"buyable": s["buyable"], "sgzt": s["sgzt"], "name": s["name"], "sgztMark": s["sgztMark"]}
        was_buyable = bool(prev.get(code, {}).get("buyable", False))
        print("  %s %s 状态：%s -> 可买=%s" % (code, s["name"], s["sgzt"], s["buyable"]))
        # 仅在「上次不可买 → 本次可买」的跳变时提醒，去重
        if s["buyable"] and not was_buyable:
            newly_buyable.append(s)

    if newly_buyable:
        try:
            send_mail(newly_buyable)
        except Exception as e:
            print("发信失败：%s" % e, file=sys.stderr)
            # 发信失败时不更新这些基金的状态，留待下次重试提醒
            for f in newly_buyable:
                if f["code"] in prev:
                    cur[f["code"]] = prev[f["code"]]
                else:
                    cur[f["code"]]["buyable"] = False
            raise SystemExit(1)
    else:
        print("无新变为可买的基金，不发信。")

    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"updatedAt": cn_now(), "status": cur}, f, ensure_ascii=False, indent=2)
    print("state.json 已更新。")


if __name__ == "__main__":
    main()
