"""Generate non-private screenshot fixtures for real vision acceptance."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
out.mkdir(parents=True, exist_ok=True)
font_path = "C:/Windows/Fonts/msyh.ttc"
def font(size):
    return ImageFont.truetype(font_path, size)
def canvas(title, subtitle):
    im = Image.new("RGB", (1000, 1400), "#f4f6f8")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((40, 40, 960, 1360), radius=28, fill="white")
    d.text((80, 80), title, fill="#202a34", font=font(42))
    d.text((80, 145), subtitle, fill="#637083", font=font(24))
    return im, d

im, d = canvas("微信支付 · 交易详情", "接口验收样图 · 不对应真实交易")
d.text((350, 240), "支付成功", fill="#16965e", font=font(48))
d.text((290, 345), "¥ 12.34", fill="#15202b", font=font(76))
rows = [("币种", "人民币 CNY"), ("交易类型", "消费支出"), ("商户", "验收停车场"),
        ("交易时间", "2026-11-06 10:30:00"), ("支付方式", "微信"),
        ("分类", "交通"), ("商品说明", "停车费 OCR 接口验收")]
for i, (label, value) in enumerate(rows):
    y = 530 + i * 88
    d.text((90, y), label, fill="#7a8590", font=font(28))
    d.text((315, y), value, fill="#263341", font=font(28))
d.text((90, 1230), "验收时只生成草稿；正式写入由测试事务回滚。", fill="#788391", font=font(24))
im.save(out / "ocr-payment.png")

im, d = canvas("支付账单 · 明细", "接口验收样图 · 不对应真实交易")
d.text((80, 230), "币种：人民币 CNY     支付方式：微信", fill="#354455", font=font(28))
head = [(80, "日期"), (310, "商户 / 分类"), (665, "支出金额"), (820, "状态")]
for x, value in head:
    d.text((x, 340), value, fill="#607084", font=font(25))
for i, (date, merchant, category, amount) in enumerate([
    ("2026-11-04", "验收停车场", "交通", "10.00"),
    ("2026-11-05", "验收餐厅", "餐饮", "25.00"),
    ("2026-11-06", "验收便利店", "购物", "8.50"),
]):
    y = 430 + i * 200
    d.line((80, y-30, 920, y-30), fill="#e0e6ed", width=2)
    d.text((80, y), date, fill="#273749", font=font(25))
    d.text((310, y), merchant, fill="#273749", font=font(25))
    d.text((310, y+50), "消费支出 · " + category, fill="#6f7b89", font=font(23))
    d.text((675, y), "-" + amount, fill="#273749", font=font(27))
    d.text((820, y), "支付成功", fill="#16965e", font=font(23))
d.text((80, 1130), "合计支出：¥43.50（此行是汇总，不是交易）", fill="#273749", font=font(27))
d.text((80, 1230), "多笔识别只展示核对表，不批量入账。", fill="#788391", font=font(24))
im.save(out / "ocr-statement.png")
print("Created two non-private OCR fixtures")
