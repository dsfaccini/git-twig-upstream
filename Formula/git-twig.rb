class GitTwig < Formula
  desc "Lightweight Git worktrees using native copy-on-write files"
  homepage "https://github.com/leostera/git-twig"
  version "0.4.0"
  license "MIT"
  head "https://github.com/leostera/git-twig.git", branch: "main"

  depends_on "git"
  depends_on "rust" => :build if build.head?

  on_macos do
    on_arm do
      url "https://github.com/leostera/git-twig/releases/download/v0.4.0/git-twig-v0.4.0-aarch64-apple-darwin.tar.gz"
      sha256 "22ff9d6e265ab9cacb85d0a0dc55450f40aa421317b1af432234d4af3021493a"
    end
    on_intel do
      url "https://github.com/leostera/git-twig/releases/download/v0.4.0/git-twig-v0.4.0-x86_64-apple-darwin.tar.gz"
      sha256 "3a5ea7a329b047027647390c540624eba1a6398d4cad63553136e110b98d2467"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/leostera/git-twig/releases/download/v0.4.0/git-twig-v0.4.0-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "6a4ed57d54244d36f8be38a68f7093c69bd7637553fff45fd21dc4ff536d0266"
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

