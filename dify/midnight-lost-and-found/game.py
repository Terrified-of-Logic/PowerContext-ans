"""Pure game rules, embedded unchanged in the Dify Code node."""
import copy

ITEMS = {
    "1": ("倒着下雨的伞", "伞里藏着失主没说出口的一句道歉"),
    "2": ("通往昨天的车票", "车票背面写着：不要阻止告别"),
    "3": ("总慢半拍的影子", "影子只是想有一次自己选方向"),
}
PRICES = {"1": "一个秘密", "2": "一分钟明天", "3": "一个冷笑话"}


def fresh_state():
    return {"stage": "arrival", "round": 1, "item": "", "price": "", "receipts": []}


def resolve(state, action):
    """Only explicit numbered choices change the ledger; free chat does not."""
    s = copy.deepcopy(state)
    action = action.strip()
    changed = False
    if action == "重新开局":
        s.update(stage="arrival", round=s["round"] + 1, item="", price="")
        changed = True
    if action == "档案":
        scene = "旧账本翻开了。" + ("\n".join(s["receipts"]) or "还没有完成的交易。")
    elif s["stage"] == "arrival":
        if action in ITEMS:
            s.update(stage="bargain", item=ITEMS[action][0])
            scene = "你拿起了“%s”。%s。" % ITEMS[action]
            changed = True
        else:
            scene = "零点的钟只响了十一下。店主阿迟说：这里寄存的，都是现实放不下的东西。"
    elif s["stage"] == "bargain":
        if action in PRICES:
            s.update(stage="delivery", price=PRICES[action])
            scene = "你以“%s”换取了“%s”的认领资格。阿迟盖章：代价已付，去向由你。" % (s["price"], s["item"])
            changed = True
        else:
            scene = "阿迟敲了敲价目表：认领资格不能用钱买。请选择一种代价。"
    elif s["stage"] == "delivery":
        endings = {"1": "归还失主", "2": "暂存店中", "3": "带回现实"}
        if action in endings:
            receipt = "第%d夜：%s；代价：%s；去向：%s。" % (s["round"], s["item"], s["price"], endings[action])
            s["receipts"] = (s["receipts"] + [receipt])[-12:]
            s["stage"] = "ended"
            scene = receipt + "阿迟把收据折成纸鹤：下次见，我会记得。"
            changed = True
        else:
            scene = "门外有人敲门，声音像那件失物。你还有最后一个决定。"
    else:
        scene = "阿迟认出了你，摊开上次的收据：" + s["receipts"][-1] + "输入“重新开局”，再收一件失物。"
    choices = {
        "arrival": "1 · 倒着下雨的伞\n2 · 通往昨天的车票\n3 · 总慢半拍的影子",
        "bargain": "1 · 一个秘密\n2 · 一分钟明天\n3 · 一个冷笑话",
        "delivery": "1 · 归还失主\n2 · 暂存店中\n3 · 带回现实",
        "ended": "重新开局 · 开始下一夜\n档案 · 查看旧账本",
    }[s["stage"]]
    memory = "\n".join(s["receipts"][-3:]) or "第一次来访，没有历史交易。"
    return {"state": s, "changed": changed, "scene": scene, "choices": choices, "memory": memory}
