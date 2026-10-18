using VbApp;
using Text = System.Text.Encoding;

namespace CSharpApp;

public class Program
{
    public static void Main(string[] args)
    {
        var widget = new Widget();
        // class NotAClass {}
        var text = "class AlsoNot";
    }
}

public record Size(int Width, int Height);

public enum Kind
{
    One
}
