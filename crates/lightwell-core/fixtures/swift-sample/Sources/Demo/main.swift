import Greeting

@main
struct DemoApp {
    static func main() {
        let greeter = Greeter()
        print(greeter.greet(name: "Lightwell"))
    }
}
