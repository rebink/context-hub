from pkg.core import Greeter

def run() -> str:
    service = Greeter("Hello")
    return service.greet("world")

if __name__ == "__main__":
    print(run())
