#!/usr/bin/env python3
"""将 PaperMind 逐字讲稿 Markdown 转为紧凑打印版 PDF（不分页，连续排版）"""

import re
from fpdf import FPDF

# ── Parse the markdown ──────────────────────────────────────
with open("docs/Papermind逐字讲稿.md", "r") as f:
    md_text = f.read()

slides = []
current_title = None
current_lines = []

for line in md_text.split('\n'):
    m = re.match(r'^## Slide (\d+) [—\-]+ (.+)$', line)
    if m:
        if current_title:
            slides.append((current_title, '\n'.join(current_lines).strip()))
        current_title = f"Slide {m.group(1)} — {m.group(2)}"
        current_lines = []
    elif current_title is not None:
        current_lines.append(line)

if current_title:
    slides.append((current_title, '\n'.join(current_lines).strip()))

# ── Font ────────────────────────────────────────────────────
FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"

def clean(text):
    """Strip markdown markers"""
    for emoji, ascii in [('✅', '[Y]'), ('✗', '[X]'), ('—', '--')]:
        text = text.replace(emoji, ascii)
    text = text.replace('**', '').replace('`', '')
    return text

def has_cjk(text):
    return any('一' <= c <= '鿿' or '　' <= c <= '〿' for c in text)

# ── PDF Builder ─────────────────────────────────────────────
class Printer(FPDF):
    def __init__(self):
        super().__init__('P', 'mm', 'A4')
        self.add_font('Heiti', '', FONT_PATH)
        self.add_font('Heiti', 'B', FONT_PATH)
        self.set_auto_page_break(True, 16)
        self.l_margin = 18
        self.r_margin = 18
        self.t_margin = 16

    def header(self):
        if self.page_no() <= 1:
            return
        self.set_font('Heiti', '', 6.5)
        self.set_text_color(155, 155, 165)
        self.cell(0, 4, 'Papermind 逐字讲稿', align='R')
        self.ln(5)

    def footer(self):
        if self.page_no() <= 1:
            return
        self.set_y(-14)
        self.set_font('Heiti', '', 7.5)
        self.set_text_color(140, 140, 150)
        self.cell(0, 9, f'— {self.page_no()} —', align='C')

    def add_title_page(self):
        self.add_page()
        self.set_fill_color(25, 28, 56)
        self.rect(18, 38, 174, 3, 'F')

        self.ln(48)
        self.set_font('Heiti', 'B', 28)
        self.set_text_color(25, 28, 56)
        self.cell(0, 13, 'Papermind', align='C')
        self.ln(16)

        self.set_font('Heiti', '', 15)
        self.set_text_color(50, 50, 85)
        self.cell(0, 9, '多智能体驱动的知识自生长系统', align='C')
        self.ln(12)

        self.set_font('Heiti', '', 11)
        self.set_text_color(90, 90, 120)
        self.cell(0, 7, '从"导入"到"反思"的全链路智能学习闭环', align='C')
        self.ln(12)

        self.set_draw_color(25, 28, 56)
        self.set_line_width(0.4)
        y = self.get_y()
        self.line(75, y, 135, y)
        self.ln(12)

        self.set_font('Heiti', '', 11)
        self.set_text_color(70, 70, 100)
        self.cell(0, 7, '项目负责人：徐阳 · 黄思颖', align='C')
        self.ln(8)

        self.set_font('Heiti', '', 9)
        self.set_text_color(120, 120, 145)
        self.cell(0, 6, '汇报时长约 8 分钟  |  15 页幻灯片  |  2026 年 6 月', align='C')

        self.set_fill_color(25, 28, 56)
        self.rect(18, 252, 174, 2, 'F')

    def section_heading(self, title):
        """Compact slide section heading — no page break"""
        self.ln(4)
        # Check if we need a new page
        if self.get_y() > self.h - 30:
            self.add_page()
        bar_h = 7
        # Draw filled bar
        self.set_fill_color(25, 28, 56)
        self.set_draw_color(25, 28, 56)
        x0 = self.l_margin
        y0 = self.get_y()
        self.rect(x0, y0, self.w - self.l_margin - self.r_margin, bar_h, 'FD')
        # White text inside bar — use cell so fpdf manages positioning correctly
        self.set_xy(x0 + 2, y0)
        self.set_text_color(255, 255, 255)
        self.set_font('Heiti', 'B', 9.5)
        self.cell(0, bar_h, title, align='L')
        # Move cursor below bar + generous spacing
        self.set_y(y0 + bar_h + 5)

    def render_body_line(self, line):
        """Render one line of body text with compact spacing"""
        if not line:
            self.ln(1.5)
            return

        # Table row
        if line.startswith('| ') and ' | ' in line:
            self.set_font('Heiti', '', 7.5)
            self.set_text_color(55, 55, 70)
            self.set_x(self.l_margin + 2)
            self.multi_cell(self.w - self.l_margin - self.r_margin - 4, 3.8, line, align='L')
            return

        # Horizontal rule
        if line == '---':
            self.set_draw_color(210, 210, 220)
            self.set_line_width(0.2)
            y = self.get_y() + 0.5
            self.line(self.l_margin + 25, y, self.w - self.r_margin - 25, y)
            self.ln(3.5)
            return

        # Pull quote
        if line.startswith('——') or line.startswith('—'):
            self.ln(1)
            self.set_font('Heiti', 'B', 9.5)
            self.set_text_color(45, 45, 80)
            self.set_x(self.l_margin + 6)
            qw = self.w - self.l_margin - self.r_margin - 12
            self.multi_cell(qw, 5, clean(line), align='C')
            self.ln(2)
            return

        # Stage direction
        if line.startswith('*（') and line.endswith('）'):
            self.set_font('Heiti', '', 8)
            self.set_text_color(130, 130, 150)
            self.multi_cell(0, 4.5, line.strip('*'), align='L')
            return

        # Ordered list
        if re.match(r'^\d+\.\s', line):
            m2 = re.match(r'^(\d+\.\s)', line)
            num = m2.group(1)
            rest = line[m2.end():]
            self.set_x(self.l_margin + 3)
            self.set_font('Heiti', '', 9.5)
            self.set_text_color(40, 40, 60)
            self.write(5, num)
            self._write_rich(rest, indent=3 + self.get_string_width(num), size=9.5)
            return

        # Unordered list
        if line.startswith('- '):
            self._write_rich('• ' + line[2:], indent=4, size=9.5)
            return

        # Normal paragraph
        self._write_rich(line, indent=0, size=9.5)

    def _write_rich(self, text, indent=0, size=9.5):
        """Write a paragraph with inline **bold** and `code` styling"""
        segments = re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', text)
        x0 = self.l_margin + indent
        self.set_x(x0)

        for seg in segments:
            if not seg:
                continue
            if seg.startswith('**') and seg.endswith('**'):
                self.set_font('Heiti', 'B', size)
                self.set_text_color(25, 28, 56)
                chunk = seg[2:-2]
            elif seg.startswith('`') and seg.endswith('`'):
                chunk = seg[1:-1]
                if has_cjk(chunk):
                    self.set_font('Heiti', '', size)
                    self.set_text_color(80, 40, 100)
                else:
                    self.set_font('Courier', '', max(size - 1, 7.5))
                    self.set_text_color(80, 40, 100)
            else:
                self.set_font('Heiti', '', size)
                self.set_text_color(40, 40, 60)
                chunk = seg
            self.write(size * 0.52, chunk)
        self.ln(size * 0.52 + 1.2)


# ── Main ────────────────────────────────────────────────────
pdf = Printer()
pdf.add_title_page()

for title, body in slides:
    if not body.strip():
        continue
    pdf.section_heading(title)
    for raw in body.split('\n'):
        pdf.render_body_line(raw.strip())

output = "docs/Papermind逐字讲稿-打印版.pdf"
pdf.output(output)
print(f"✅ {output}")
print(f"   Pages: {pdf.page_no()}  |  Slides: {len(slides)}")
