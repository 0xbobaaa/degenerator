.PHONY: install test example clean

install:
	pip install -e .

test:
	python -m unittest discover -s tests -q

example:
	python -m degenerator.cli new examples/momentum.spec.md -o build/momentum-degen --force

clean:
	rm -rf build *.egg-info runs
