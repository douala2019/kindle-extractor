#!/usr/bin/env python3
"""
Kindle Book Translator — литературный перевод через Claude или GPT
Читает PNG из ~/Downloads/kindle_book/, создаёт original.pdf и translated_ru.pdf.

Установка:
  pip3 install pillow pytesseract fpdf2 anthropic openai
  brew install tesseract                          # macOS

Использование:
  python3 translate_book.py --engine claude       # через Claude (рекомендуется)
  python3 translate_book.py --engine gpt          # через GPT-4o
  python3 translate_book.py --only-pdf            # только PDF без перевода
  python3 translate_book.py --lang de             # другой язык

API-ключи — через переменные окружения:
  export ANTHROPIC_API_KEY=sk-ant-...
  export OPENAI_API_KEY=sk-...
или передай флагом: --api-key sk-ant-...
"""

import os, sys, time, argparse, textwrap
from pathlib import Path

# ── literary translation prompt ────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "Ты профессиональный литературный переводчик с многолетним опытом. "
    "Твоя задача — передавать не только смысл, но и стиль, ритм и атмосферу оригинала."
)

PAGE_PROMPT = """\
Переведи следующий фрагмент книги с английского на {lang_name}.

Требования:
• Литературный стиль — как у профессионального переводчика художественной литературы
• Сохраняй авторский голос, тон, ритм и атмосферу
• Перевод должен читаться плавно, не как подстрочник
• Сохраняй разбивку на абзацы
• Не добавляй пояснений и комментариев — только перевод
{context_block}
Текст:
{text}"""

LANG_NAMES = {
    'ru': 'русский язык',
    'de': 'немецкий язык',
    'fr': 'французский язык',
    'es': 'испанский язык',
    'uk': 'украинский язык',
    'pl': 'польский язык',
}

# ── dependency check ──────────────────────────────────────────────────────────

def check_deps(engine: str, only_pdf: bool):
    missing = []
    for pkg, inst in [('PIL', 'pillow'), ('fpdf', 'fpdf2')]:
        try: __import__(pkg)
        except ImportError: missing.append(inst)

    if not only_pdf:
        try: __import__('pytesseract')
        except ImportError: missing.append('pytesseract')

        if engine == 'claude':
            try: __import__('anthropic')
            except ImportError: missing.append('anthropic')
        elif engine == 'gpt':
            try: __import__('openai')
            except ImportError: missing.append('openai')

    if missing:
        print(f"Установи: pip3 install {' '.join(missing)}")
        sys.exit(1)

    if not only_pdf:
        import pytesseract
        try:
            pytesseract.get_tesseract_version()
        except Exception:
            print("Установи Tesseract:\n  brew install tesseract   # macOS")
            sys.exit(1)

# ── OCR ───────────────────────────────────────────────────────────────────────

def ocr_page(img_path: str, ocr_lang: str = 'eng') -> str:
    from PIL import Image, ImageFilter
    import pytesseract
    img = Image.open(img_path).convert('L')
    img = img.filter(ImageFilter.SHARPEN)
    text = pytesseract.image_to_string(img, lang=ocr_lang, config='--psm 1 --oem 3')
    return text.strip()

# ── translation engines ───────────────────────────────────────────────────────

def build_prompt(text: str, lang: str, prev_tail: str) -> str:
    lang_name = LANG_NAMES.get(lang, lang)
    if prev_tail:
        ctx = f"\nДля связности — конец предыдущей страницы (не переводи, только для контекста):\n«{prev_tail}»\n"
    else:
        ctx = ''
    return PAGE_PROMPT.format(lang_name=lang_name, context_block=ctx, text=text)

def translate_claude(text: str, lang: str, prev_tail: str, api_key: str, model: str) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    prompt = build_prompt(text, lang, prev_tail)
    for attempt in range(3):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text.strip()
        except Exception as e:
            if attempt == 2: raise
            wait = 10 * (attempt + 1)
            print(f"\n    ⚠️  {e} — retry in {wait}s…", end='', flush=True)
            time.sleep(wait)

def translate_gpt(text: str, lang: str, prev_tail: str, api_key: str, model: str) -> str:
    import openai
    client = openai.OpenAI(api_key=api_key)
    prompt = build_prompt(text, lang, prev_tail)
    for attempt in range(3):
        try:
            response = client.chat.completions.create(
                model=model,
                temperature=0.3,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": prompt},
                ],
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            if attempt == 2: raise
            wait = 10 * (attempt + 1)
            print(f"\n    ⚠️  {e} — retry in {wait}s…", end='', flush=True)
            time.sleep(wait)

def translate_page(text: str, lang: str, prev_tail: str,
                   engine: str, api_key: str, model: str) -> str:
    if not text.strip():
        return ''
    if engine == 'claude':
        return translate_claude(text, lang, prev_tail, api_key, model)
    elif engine == 'gpt':
        return translate_gpt(text, lang, prev_tail, api_key, model)
    else:
        raise ValueError(f"Неизвестный движок: {engine}")

# ── original PDF ──────────────────────────────────────────────────────────────

def images_to_pdf(png_files: list, output: str):
    from PIL import Image
    import io

    if not png_files:
        print("  ⚠️  Нет PNG-файлов")
        return

    print(f"  Собираю {len(png_files)} страниц в PDF…")
    imgs = []
    for i, p in enumerate(png_files):
        img = Image.open(p).convert('RGB')
        imgs.append(img)
        if (i + 1) % 20 == 0:
            print(f"    загружено {i+1}/{len(png_files)}…")

    # Pillow save_all=True creates a real multi-page PDF
    imgs[0].save(
        output,
        format='PDF',
        save_all=True,
        append_images=imgs[1:],
        resolution=150,
    )
    size_mb = os.path.getsize(output) / 1024 / 1024
    print(f"  ✅ {output}  ({len(imgs)} стр., {size_mb:.1f} МБ)")

# ── translated PDF ────────────────────────────────────────────────────────────

FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    str(Path(__file__).parent / 'DejaVuSans.ttf'),
]

def get_font() -> str:
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    local = Path(__file__).parent / 'DejaVuSans.ttf'
    print("  ⬇️  Скачиваю шрифт DejaVuSans.ttf…")
    import urllib.request
    urllib.request.urlretrieve(
        'https://github.com/dejavu-fonts/dejavu-fonts/raw/master/ttf/DejaVuSans.ttf',
        local,
    )
    return str(local)

def texts_to_pdf(pages: list, output: str, font_path: str):
    from fpdf import FPDF
    pdf = FPDF(format='A4')
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_font('main', '', font_path, uni=True)
    W = pdf.w - 30

    for i, text in enumerate(pages, 1):
        pdf.add_page()
        # page number header
        pdf.set_font('main', size=8)
        pdf.set_text_color(160, 160, 160)
        pdf.cell(W, 5, f'стр. {i}', ln=True)
        pdf.ln(2)
        # body
        pdf.set_font('main', size=11)
        pdf.set_text_color(30, 30, 30)
        for line in text.split('\n'):
            line = line.strip()
            if not line:
                pdf.ln(4)
                continue
            for wrapped in textwrap.wrap(line, width=88) or ['']:
                pdf.multi_cell(W, 6, wrapped)

    pdf.output(output)
    print(f"  ✅ {output}  ({os.path.getsize(output)/1024/1024:.1f} МБ)")

# ── main ──────────────────────────────────────────────────────────────────────

def resolve_api_key(engine: str, arg_key: str) -> str:
    key = arg_key
    if not key:
        env = 'ANTHROPIC_API_KEY' if engine == 'claude' else 'OPENAI_API_KEY'
        key = os.environ.get(env, '')
    if not key:
        env = 'ANTHROPIC_API_KEY' if engine == 'claude' else 'OPENAI_API_KEY'
        key = input(f"Введи API-ключ ({env}): ").strip()
    return key

def main():
    parser = argparse.ArgumentParser(description='OCR + литературный перевод Kindle → PDF')
    parser.add_argument('--dir',      default=str(Path.home() / 'Downloads' / 'kindle_book'))
    parser.add_argument('--engine',   default='claude', choices=['claude', 'gpt'],
                        help='Движок перевода: claude или gpt (default: claude)')
    parser.add_argument('--model',    default='',
                        help='Модель (default: claude-sonnet-4-5 / gpt-4o)')
    parser.add_argument('--api-key',  default='', dest='api_key')
    parser.add_argument('--lang',     default='ru')
    parser.add_argument('--ocr-lang', default='eng', dest='ocr_lang')
    parser.add_argument('--only-pdf', action='store_true',
                        help='Только оригинальный PDF, без OCR и перевода')
    parser.add_argument('--start',    type=int, default=1,
                        help='Начать с этой страницы (для продолжения)')
    args = parser.parse_args()

    check_deps(args.engine, args.only_pdf)

    # default models
    if not args.model:
        args.model = 'claude-sonnet-4-5' if args.engine == 'claude' else 'gpt-4o'

    png_dir = Path(args.dir)
    if not png_dir.exists():
        print(f"Папка не найдена: {png_dir}")
        print("Сначала собери скриншоты кнопкой «📸 Скриншоты + PDF» в расширении.")
        sys.exit(1)

    # Accept any PNG naming: page_0001.png, 0001.png, Page 1.png, etc.
    png_files = sorted(png_dir.glob('*.png'))
    if not png_files:
        print(f"PNG-файлы не найдены в: {png_dir}")
        print(f"\nУкажи папку явно:")
        print(f'  python3 translate_book.py --dir "/путь/к/папке/с/PNG"')
        sys.exit(1)

    print(f"📂 {png_dir}")
    print(f"📄 Найдено PNG: {len(png_files)}")
    print(f"   Первый: {png_files[0].name}")
    print(f"   Последний: {png_files[-1].name}")
    if not args.only_pdf:
        print(f"🤖 Движок: {args.engine} / {args.model}  →  язык: {args.lang}\n")

    # ── original PDF ──────────────────────────────────────────────────────────
    print("📄 Создаю оригинальный PDF…")
    orig_path = str(png_dir / 'original.pdf')
    images_to_pdf([str(p) for p in png_files], orig_path)

    if args.only_pdf:
        print("\n✅ Готово!")
        return

    # ── OCR + translate ───────────────────────────────────────────────────────
    api_key = resolve_api_key(args.engine, args.api_key)
    trans_path = str(png_dir / f'translated_{args.lang}.pdf')

    # Load existing translations if resuming
    translated_pages: list[str] = [''] * len(png_files)
    resume_file = png_dir / f'.resume_{args.lang}.txt'
    if args.start > 1 and resume_file.exists():
        parts = resume_file.read_text(encoding='utf-8').split('\n<<<PAGE>>>\n')
        for i, part in enumerate(parts):
            if i < len(translated_pages):
                translated_pages[i] = part
        print(f"  ↩️  Продолжаю с страницы {args.start}")

    print(f"\n🔍 OCR + перевод…")
    prev_tail = ''

    for i, png in enumerate(png_files):
        page_num = i + 1
        if page_num < args.start:
            continue

        print(f"  [{page_num:3d}/{len(png_files)}]", end='', flush=True)

        text = ocr_page(str(png), args.ocr_lang)
        words = len(text.split())
        print(f"  {words:4d} слов → перевод…", end='', flush=True)

        t0 = time.time()
        translated = translate_page(text, args.lang, prev_tail, args.engine, api_key, args.model)
        elapsed = time.time() - t0
        print(f" ✓ ({elapsed:.1f}s)")

        translated_pages[i] = translated
        # Keep last ~200 chars of translated text as context for next page
        prev_tail = translated[-200:].strip() if translated else ''

        # Save progress after each page
        resume_file.write_text('\n<<<PAGE>>>\n'.join(translated_pages), encoding='utf-8')

    # ── translated PDF ────────────────────────────────────────────────────────
    print(f"\n📄 Создаю PDF перевода…")
    font_path = get_font()
    texts_to_pdf(translated_pages, trans_path, font_path)

    # Cleanup resume file on success
    if resume_file.exists():
        resume_file.unlink()

    print(f"\n✅ Готово!")
    print(f"   Оригинал : {orig_path}")
    print(f"   Перевод  : {trans_path}")


if __name__ == '__main__':
    main()
