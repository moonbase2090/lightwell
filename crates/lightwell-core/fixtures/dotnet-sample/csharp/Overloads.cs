namespace CSharpApp;
public class Overloads
{
    public int Choose(int value)
    {
        return value;
    }

    public int Choose(string value)
    {
        return value.Length;
    }
}
