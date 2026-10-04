# Nerd Fonts

This is an archived font from the Nerd Fonts release v3.5.1.

For more information see:
* https://github.com/ryanoasis/nerd-fonts/
* https://github.com/ryanoasis/nerd-fonts/releases/latest/

# Symbols Only

Bundled from Nerd Fonts v3.5.1:
https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz

`nerd-fonts-symbols.woff2` is `SymbolsNerdFont-Regular.ttf` converted to WOFF2
with FontTools 4.66.1 and Brotli 1.2.0. All 10,624 encoded glyphs and the
original font names and copyright metadata are retained. No glyphs were
modified. The archive's `LICENSE` is included as `LICENSE-NERD-FONTS`.

To reproduce after extracting the release archive:

```sh
python -m pip install 'fonttools[woff]==4.66.1' 'brotli==1.2.0'
fonttools ttLib.woff2 compress SymbolsNerdFont-Regular.ttf -o nerd-fonts-symbols.woff2
```

The extension uses a separate CSS family and places it after original site
fonts, so their private-use icon mappings take precedence. Code, semantic
opt-outs, and nonconverted ordinary text retain their original font families.

The upstream attribution follows.

This font contains (in the patched-fonts folder) all symbols and is intended to be used
as fallback or together with fontconfig - so that you do not need to individually
patch all the fonts. YMMV.

## Icon sets

| Icon set name          | upstream                                              | version         | license     |
|------------------------|-------------------------------------------------------|-----------------|-------------|
| Codicons               | https://github.com/microsoft/vscode-codicons          | 0.0.45          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | 2.17.0          | MIT         |
| extraglyphs            | https://github.com/source-foundry/Hack                | -               | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | 6.5.1           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | 0.0.3           | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | 1.3.0           | unlicensed  |
| MaterialDesign         | https://github.com/Templarian/MaterialDesign-Font     | Oct 6, 2022     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | 18.3.0          | MIT         |
| Seti and original      | https://github.com/jesseweed/seti-ui                  | 0.8.1           | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | 1.001           | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | 1.200           | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | 1.000 (ca 2013) | MIT         |
| Power Symbols IEC      | https://github.com/jloughry/Unicode                   | Feb 2015        | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | 2.0.10 (1.100)  | OFL 1.1     |

## Which font?

### TL;DR

* Pick your font family:
  * If you are limited to monospaced fonts (because of your terminal, etc) then pick a font with `Nerd Font Mono` (or `NFM`).
  * If you want to have bigger icons (usually around 1.5 normal letters wide) pick a font without `Mono` i.e. `Nerd Font` (or `NF`). Most terminals support this, but ymmv.
  * If you work in a proportional context (GUI elements or edit a presentation etc) pick a font with `Nerd Font Propo` (or `NFP`).

### Ligatures

Ligatures are generally preserved in the patched fonts.
Nerd Fonts `v2.0.0` had no ligatures in the `Nerd Font Mono` fonts, this has been dropped with `v2.1.0`.
If you have a ligature-aware terminal and don't want ligatures you can (usually) disable them in the terminal settings.

### Explanation

Once you narrow down your font choice of family (`Droid Sans`, `Inconsolata`, etc) and style (`bold`, `italic`, etc) you have 2 main choices:

#### `Option 1: Download already patched font`

 * For a stable version download a font package from the [release page](https://github.com/ryanoasis/nerd-fonts/releases)
   * [NerdFontsSymbolsOnly.zip](https://github.com/ryanoasis/nerd-fonts/releases/latest/download/NerdFontsSymbolsOnly.zip)
   * [NerdFontsSymbolsOnly.tar.xz](https://github.com/ryanoasis/nerd-fonts/releases/latest/download/NerdFontsSymbolsOnly.tar.xz) (smaller)
 * Or download the development version from the folders here

#### `Option 2: Patch your own font`

 * Patch your own variations with the various options provided by the font patcher (i.e. not include all symbols for smaller font size)

For more information see: [The FAQ](https://github.com/ryanoasis/nerd-fonts/wiki/FAQ-and-Troubleshooting#which-font)

[SIL-RFN]:http://scripts.sil.org/cms/scripts/page.php?item_id=OFL_web_fonts_and_RFNs#14cbfd4a
