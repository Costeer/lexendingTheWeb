# Lexend for the Web

Read websites in [Lexend](https://www.lexend.com/). Choose which text to change,
adjust its size and spacing, and pause the extension on sites where you prefer
the original font.

This is an unofficial project, unaffiliated with and not endorsed by Lexend's creators.

## Using Lexend

Open the extension from your browser's toolbar. Choose **Body text** for paragraphs,
links, labels and controls, or **Body and headings** to include headings too.
Use **Pause here** to keep the current site's font, or the master switch to turn
Lexend off everywhere. The shortcut is `Ctrl+Shift+L` (`Command+Shift+L` on macOS).

Open **Settings** with the gear button to adjust text size, line height and letter
spacing. The preview offers **Reading**, **Compare** and **Glyphs** views. **Try your
own text** lets you preview a sample without saving or sending it.

Layout repair is off by default. Enable **Layout repair on this site** in the popup
when text needs more room, or **Enable layout repair on all sites** in Settings.
The all-sites switch leaves your saved site choices intact. See
[layout adjustments](docs/adaptive-layout.md) for what repair can change.

Search and edit saved site rules in Settings. Each rule can cover one hostname
or include its subdomains. Settings sync when browser sync is enabled. You can
export a JSON backup, preview an import, and conditionally undo an import while
Settings stays open. See [site rules and backup recovery](docs/rule-controls.md).

Code, math, SVG artwork and common icon fonts keep their original fonts. Missing
icons can use the included Nerd Fonts symbols. Browser settings and extension
stores restrict extensions; the popup tells you when Lexend cannot change a page.

## Installation

Download the appropriate archive from [Releases](https://github.com/Costeer/lexendingTheWeb/releases)
and extract it. For Chrome, open `chrome://extensions`, turn on **Developer mode**,
choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
For a temporary Firefox installation, open `about:debugging#/runtime/this-firefox`,
choose **Load Temporary Add-on**, and select the extracted `manifest.json`.
Firefox removes temporary installations when the browser closes.

After replacing an installed folder, reload the extension from your browser's
extension manager and reopen its popup and Settings.

## Privacy and support

Fonts are included with the extension. Page text stays in your browser. There
are no analytics or trackers. Preferences and site rules use your browser's
synchronized extension storage; the developer does not receive them.
Read the [privacy policy](PRIVACY.md), also available in [HTML](docs/privacy.html).

If something looks wrong, pause Lexend on that site and
[report the problem](https://github.com/Costeer/lexendingTheWeb/issues).
You can [save local diagnostics](docs/diagnostics.md) to help identify your
installed version and settings. Review the file before sharing it.

## For website authors

Add `data-lexend-ignore` to an element to keep its original typography and that
of its children:

```html
<section data-lexend-ignore>Keep this section's fonts and spacing.</section>
```

## License

Source code uses the [MIT License](LICENSE). Lexend uses the
[SIL Open Font License 1.1](assets/fonts/LICENSE). Bundled Nerd Fonts symbols
include their [license](assets/fonts/LICENSE-NERD-FONTS) and
[attributions](assets/fonts/NOTICE-NERD-FONTS).
