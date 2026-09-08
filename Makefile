.PHONY: install test example site clean

install:
	pip install -e .

test:
	python -m unittest discover -s tests -q

example:
	python -m degenerator.cli new examples/momentum.spec.md -o build/momentum-degen --force

site:
	python -m http.server -d docs 8000

clean:
	rm -rf build *.egg-info runs
