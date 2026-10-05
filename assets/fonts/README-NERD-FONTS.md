# Bundled Nerd Fonts symbols

Lexend for the Web includes a symbols-only font from
[Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1).
It supplies missing icons when a site's own fonts cannot display them.

The extension puts this fallback after the site's original fonts in a separate
CSS font family. A site's own private-use icon mappings take precedence. Code,
elements excluded from conversion, and ordinary text that has not been
converted keep their original font families.

## Source and conversion

The source file is `SymbolsNerdFont-Regular.ttf` from the
[v3.5.1 Symbols Only archive](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz).
It was converted to `nerd-fonts-symbols.woff2` with FontTools 4.66.1 and
Brotli 1.2.0. The conversion keeps all 10,624 encoded glyphs, the original font
names, and the copyright metadata.

The archive's license is included in [LICENSE-NERD-FONTS](LICENSE-NERD-FONTS).

With Nix installed, run this from the repository root:

```sh
mkdir -p dist
nix-build scripts/build-nerd-font.nix --out-link dist/nerd-font
```

The [build](../../scripts/build-nerd-font.nix) pins Nixpkgs, the source archive,
FontTools 4.66.1, and Brotli 1.2.0. It fixes the conversion timestamp and checks
that the result matches the bundled font byte for byte. The font and its
license are written to `dist/nerd-font/`.

## Icon sources and attribution

Nerd Fonts combines symbols from the projects below. Its Symbols Only font
provides those symbols as a fallback, including for use with fontconfig,
without requiring each text font to be patched. The table retains the icon
sources, versions, and licenses listed in the upstream release.

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
