class GitTwig < Formula
  desc "Lightweight Git worktrees using native copy-on-write files"
  homepage "https://github.com/leostera/git-twig"
  version "0.5.0"
  license "MIT"
  head "https://github.com/leostera/git-twig.git", branch: "main"

  depends_on "git"
  depends_on "rust" => :build if build.head?

  on_macos do
    on_arm do
      url "https://github.com/leostera/git-twig/releases/download/v0.5.0/git-twig-v0.5.0-aarch64-apple-darwin.tar.gz"
      sha256 "5a87935d88ee9e3a7b861a7c2b87db23bb9ee0058fab4f9e0092cb5f0427b16a"
    end
    on_intel do
      url "https://github.com/leostera/git-twig/releases/download/v0.5.0/git-twig-v0.5.0-x86_64-apple-darwin.tar.gz"
      sha256 "c20a5d36828c6b34ab37aa5427eb95154fa6124a816f29136a63d9e10b594625"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/leostera/git-twig/releases/download/v0.5.0/git-twig-v0.5.0-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "819e1ebea0039fc440f255fc5abb2d8be735a831e54c9b93d082bd3e0301eea5"
    end
  end

  def install
    if build.head?
      system "cargo", "install", "--locked", "--path", "crates/git-twig", "--root", prefix
      man1.install "crates/git-twig/man/git-twig.1"
    else
      bin.install "git-twig"
      man1.install "git-twig.1"
    end
  end

  test do
    assert_match "git-twig", shell_output("#{bin}/git-twig --version")
  end
end

