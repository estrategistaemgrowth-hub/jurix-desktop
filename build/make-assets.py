"""Gera as artes do instalador a partir do ícone do Jurix.

Uso: python desktop/build/make-assets.py [caminho/da/fonte-de-titulo.ttf]
Saídas (nesta pasta): icon.ico, installer-sidebar.bmp (Windows), icon-1024.png,
dmg-background.png e @2x (Mac).
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
INK = (6, 27, 49)
PRIMARY = (114, 50, 241)
FALLBACK_FONT = "C:/Windows/Fonts/segoeuib.ttf"


def font(size, title_font):
    path = title_font or FALLBACK_FONT
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_axes([800])  # Schibsted Grotesk variável: peso 800
    except (OSError, ValueError):
        pass
    return f


def ink_background(w, h, glow_at):
    """Tinta Jurix com brilho roxo saindo de um canto (mesmo gesto do onboarding)."""
    img = Image.new("RGB", (w, h), INK)
    glow = Image.new("RGB", (w, h), INK)
    d = ImageDraw.Draw(glow)
    gx, gy = glow_at
    r = int(max(w, h) * 0.75)
    d.ellipse((gx - r, gy - r, gx + r, gy + r), fill=PRIMARY)
    glow = glow.filter(ImageFilter.GaussianBlur(max(w, h) * 0.28))
    return Image.blend(img, glow, 0.55)


def paste_icon(base, icon, size, center):
    mark = icon.resize((size, size), Image.LANCZOS)
    base.paste(mark, (center[0] - size // 2, center[1] - size // 2), mark)


def main():
    title_font = sys.argv[1] if len(sys.argv) > 1 else None
    icon = Image.open(HERE / "icon.png").convert("RGBA")

    icon.save(HERE / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    # O Mac exige ícone de pelo menos 512x512; o icon.png do site tem 500x500.
    icon.resize((1024, 1024), Image.LANCZOS).save(HERE / "icon-1024.png")

    # Lateral das telas do instalador do Windows: 164x314, BMP 24 bits.
    side = ink_background(164, 314, (150, 330))
    paste_icon(side, icon, 96, (82, 104))
    d = ImageDraw.Draw(side)
    d.text((82, 196), "Jurix", font=font(30, title_font), fill=(255, 255, 255), anchor="mm")
    d.text((82, 226), "para computador", font=ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 13),
           fill=(205, 196, 235), anchor="mm")
    side.save(HERE / "installer-sidebar.bmp")

    # Fundo da janela do .dmg (ícones em x=170 e x=470, y=220) e versão retina.
    for scale, name in ((1, "dmg-background.png"), (2, "dmg-background@2x.png")):
        w, h = 640 * scale, 420 * scale
        bg = ink_background(w, h, (w, h))
        d = ImageDraw.Draw(bg)
        d.text((w // 2, 74 * scale), "Arraste o Jurix para Aplicativos", font=font(26 * scale, title_font),
               fill=(255, 255, 255), anchor="mm")
        # Seta entre o app e a pasta Aplicativos.
        y = 220 * scale
        d.line((262 * scale, y, 372 * scale, y), fill=(190, 170, 250), width=4 * scale)
        d.polygon([(386 * scale, y), (366 * scale, y - 12 * scale), (366 * scale, y + 12 * scale)],
                  fill=(190, 170, 250))
        bg.save(HERE / name)

    print("artes geradas em", HERE)


if __name__ == "__main__":
    main()
