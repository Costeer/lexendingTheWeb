{ system ? builtins.currentSystem }:

let
  pkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/a7868a727837f3c09cee2ce0ca671c76b1589fed.tar.gz";
    sha256 = "0z1daxh826r5d877fa77576ihfq4lzhzwys0ggnppw8bld42s0ia";
  }) {
    inherit system;
    config = { };
    overlays = [ ];
  };

  fonttools = pkgs.python3Packages.fonttools.overridePythonAttrs (_: {
    version = "4.66.1";
    src = pkgs.fetchPypi {
      pname = "fonttools";
      version = "4.66.1";
      sha256 = "64967c6ddb0d4c610dfd8cb1485981b2d27972ddfb7d4bbbd9e199d2a089c450";
    };
    nativeCheckInputs = [ ];
    doCheck = false;
  });

  python = pkgs.python3.withPackages (ps: [ fonttools ps.brotli ]);
in
assert pkgs.python3Packages.brotli.version == "1.2.0";
pkgs.stdenvNoCC.mkDerivation {
  pname = "lexend-nerd-font-symbols";
  version = "3.5.1";

  src = pkgs.fetchurl {
    url = "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz";
    sha256 = "15lrlqipp84s86dx8108cf34d7qw21j5rjz50aqyshw5vcvjy5q1";
  };
  sourceRoot = ".";
  nativeBuildInputs = [ python ];
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    # Match the bundled font's modification time: 2026-10-04 16:40:44 UTC.
    export SOURCE_DATE_EPOCH=1791132044
    python - <<'PY'
    from fontTools.ttLib import TTFont

    font = TTFont("SymbolsNerdFont-Regular.ttf")
    # Load these tables so saving uses the bundled font's table encoding.
    font.getBestCmap()
    font["name"]
    font.flavor = "woff2"
    font.save("nerd-fonts-symbols.woff2")
    PY
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    echo "6b500afc199145b6ec48e1bb88876e7595e0f214da739a1d0afe0c86d41bca0f  nerd-fonts-symbols.woff2" | sha256sum --check
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    install -m644 nerd-fonts-symbols.woff2 "$out/nerd-fonts-symbols.woff2"
    install -m644 LICENSE "$out/LICENSE-NERD-FONTS"
    runHook postInstall
  '';
}
