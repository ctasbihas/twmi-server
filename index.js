const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

const client = new MongoClient(process.env.DB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const token = authorization.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "Unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

async function run() {
  try {
    await client.connect();
    const db = client.db("twmi"); // twmi refers for TUNE WORKS MUSIC INSTITUTE
    const classesCollection = db.collection("classes");
    const usersCollection = db.collection("users");
    const selectedClassesCollection = db.collection("selectedClasses");
    const paymentsCollection = db.collection("payments");

    // JWT
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1d",
      });
      res.send({ token });
    });

    //? Classes API
    app.get("/topClasses", async (req, res) => {
      const classes = await classesCollection
        .find()
        .sort({ totalStudents: -1 })
        .limit(6)
        .toArray();
      res.json(classes);
    });
    app.get("/approvedClasses", async (req, res) => {
      const query = { status: "approved" };
      const classes = await classesCollection.find(query).toArray();
      res.send(classes);
    });
    app.post("/selectClass", verifyJWT, async (req, res) => {
      const classData = req.body;
      const result = await selectedClassesCollection.insertOne(classData);
      res.send(result);
    });
    app.get("/class/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const classData = await selectedClassesCollection.findOne(query);
      res.send(classData);
    });
    app.get("/enrolledClasses", async (req, res) => {
      const { email } = req.query;
      const query = { students: { $in: [email] } };

      try {
        const enrolledClasses = await classesCollection.find(query).toArray();
        res.json(enrolledClasses);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch enrolled classes" });
      }
    });

    //? Users API
    app.get("/users", verifyJWT, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existed = await usersCollection.findOne(query);
      if (existed) {
        return res.status(400).json({ message: "User already exists" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    app.get("/user/role/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const result = { role: user?.role };
      res.send(result);
    });

    //? Instructors API
    app.get("/instructors", async (req, res) => {
      const pipeline = [
        { $match: { role: "instructor" } },
        {
          $lookup: {
            from: "classes",
            localField: "email",
            foreignField: "instructor.email",
            as: "classes",
          },
        },
      ];
      const instructors = await usersCollection.aggregate(pipeline).toArray();
      res.send(instructors);
    });
    app.post("/addClass", verifyJWT, async (req, res) => {
      const classData = req.body;
      const result = await classesCollection.insertOne(classData);
      res.send(result);
    });
    app.get("/instructor/classes/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      const query = { "instructor.email": email };
      const result = await classesCollection.find(query).toArray();
      res.send(result);
    });

    //? Students API
    app.get("/student/classes/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      const query = { studentEmail: email };
      const result = await selectedClassesCollection.find(query).toArray();
      res.send(result);
    });
    app.delete("/student/classes/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await selectedClassesCollection.deleteOne(query);
      res.send(result);
    });

    //? Admin API
    app.get("/classes", verifyJWT, async (req, res) => {
      const classes = await classesCollection.find().toArray();
      res.send(classes);
    });
    app.patch("/users/admin/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });
    app.patch("/users/instructor/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: "instructor",
        },
      };
      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });
    app.patch("/classes/status/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const { feedback } = req.body;

      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: feedback ? "denied" : "approved",
          feedback: feedback,
        },
      };

      try {
        const result = await classesCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to update class status" });
      }
    });

    // Payment API
    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const { price } = req.body;
      if (price) {
        const amount = price * 100;

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      }
    });
    app.post("/payment", async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      const query = { _id: new ObjectId(payment.selectedClassId) };
      const deleteResult = await selectedClassesCollection.deleteOne(query);
      if (deleteResult.deletedCount === 1) {
        const classQuery = { _id: new ObjectId(payment.classId) };
        const classUpdate = {
          $inc: { enrolledStudents: 1 },
          $inc: { availableSeats: -1 },
          $push: { students: payment.email },
        };
        await classesCollection.updateOne(classQuery, classUpdate);
      }
      res.send({ result, deleteResult });
    });
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = { email };
      const payments = await paymentsCollection.find(query).toArray();
      res.send(payments);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}!`);
});
