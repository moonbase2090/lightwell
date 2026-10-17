namespace CSharpApp;

public partial class Widget : VbApp.Part, INamed
{
    public string Name { get; set; }

    public int Measure(Part item)
    {
        return item.Size;
    }
}
