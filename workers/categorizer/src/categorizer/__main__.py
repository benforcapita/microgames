import os
import sys

from categorizer import main, process_deps

if __name__ == "__main__":
    sys.exit(main(os.environ, process_deps()))
